/* =============================================================================
   analyzer.js — Audio analysis engine — Audio Design Studios
   Offline track analysis: ITU-R BS.1770-4 integrated LUFS, True Peak (4x
   Catmull-Rom), EBU Tech 3342 LRA, streaming compliance, BPM (onset-strength
   autocorrelation), Krumhansl-Schmuckler key detection, power spectral FFT,
   stereo image, DC offset, and clipping detection.

   Public API:
     AudioAnalyzer.run(audioUrl, trackName, resultsEl)
       audioUrl  – blob/object URL for the audio file
       trackName – display name shown inside the results
       resultsEl – DOM element that receives the loading indicator and results

   IMPORTANT: call run() directly from a user-gesture handler (click, etc.)
   so the AudioContext is created inside the activation window.
   ============================================================================= */

window.AudioAnalyzer = (function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // K-weighting filter — ITU-R BS.1770-4
  // Filters the ENTIRE channel signal continuously (no per-block re-init).
  // Stage 1: high-shelf at ~1.7 kHz (outer-ear / head-diffraction effect)
  // Stage 2: high-pass  at ~38 Hz  (RLB weighting / free-field transfer)
  // ---------------------------------------------------------------------------
  function kWeightFull(data, fs) {
    const n   = data.length;
    const out = new Float32Array(n);

    // Stage 1 coefficients (Giannoulis et al. 2012)
    const f0s = 1681.974450955533, Gs = 3.999843853973347, Qs = 0.7071752369554196;
    const Ks  = Math.tan(Math.PI * f0s / fs);
    const Vh  = Math.pow(10, Gs / 20);
    const Vb  = Math.pow(Vh, 0.4996667741545416);
    const d1  = 1 + Ks / Qs + Ks * Ks;
    const bs0 = (Vh + Vb * Ks / Qs + Ks * Ks) / d1;
    const bs1 = 2 * (Ks * Ks - Vh) / d1;
    const bs2 = (Vh - Vb * Ks / Qs + Ks * Ks) / d1;
    const as1 = 2 * (Ks * Ks - 1) / d1;
    const as2 = (1 - Ks / Qs + Ks * Ks) / d1;

    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const x0 = data[i];
      const y0 = bs0*x0 + bs1*x1 + bs2*x2 - as1*y1 - as2*y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      out[i] = y0;
    }

    // Stage 2 coefficients — high-pass
    const f0h = 38.13547087602444, Qh = 0.5003270373238773;
    const Kh  = Math.tan(Math.PI * f0h / fs);
    const dh  = 1 + Kh / Qh + Kh * Kh;
    const bh0 = 1 / dh, bh1 = -2 / dh, bh2 = 1 / dh;
    const ah1 = 2 * (Kh * Kh - 1) / dh;
    const ah2 = (1 - Kh / Qh + Kh * Kh) / dh;

    x1 = x2 = y1 = y2 = 0;
    for (let i = 0; i < n; i++) {
      const x0 = out[i];
      const y0 = bh0*x0 + bh1*x1 + bh2*x2 - ah1*y1 - ah2*y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      out[i] = y0;
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // Radix-2 Cooley-Tukey in-place FFT (N must be a power of two)
  // ---------------------------------------------------------------------------
  function computeFFT(re, im) {
    const N = re.length;
    let j = 0;
    for (let i = 1; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = (2 * Math.PI) / len;
      const wR = Math.cos(ang), wI = -Math.sin(ang);
      for (let i = 0; i < N; i += len) {
        let uR = 1, uI = 0;
        for (let k = 0; k < (len >> 1); k++) {
          const eR = re[i+k], eI = im[i+k];
          const oR = re[i+k+(len>>1)], oI = im[i+k+(len>>1)];
          const tR = oR*uR - oI*uI, tI = oR*uI + oI*uR;
          re[i+k]          = eR + tR; im[i+k]          = eI + tI;
          re[i+k+(len>>1)] = eR - tR; im[i+k+(len>>1)] = eI - tI;
          const nuR = uR*wR - uI*wI; uI = uR*wI + uI*wR; uR = nuR;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Core async analysis
  // ---------------------------------------------------------------------------
  async function _analyse(audioCtx, audioUrl, trackName, resultsEl) {

    function upd(pct, label) {
      const bar = resultsEl.querySelector('.analysis-progress-bar');
      const txt = resultsEl.querySelector('.analysis-progress-text');
      if (bar) bar.style.width = pct + '%';
      if (txt) txt.textContent = label || (Math.round(pct) + '%');
    }

    try {
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      // ── Fetch ──────────────────────────────────────────────────────────────
      upd(5, 'Fetching audio\u2026');
      const resp = await fetch(audioUrl);
      if (!resp.ok) throw new Error('Fetch failed: ' + resp.status + ' ' + resp.statusText);
      const arrayBuf = await resp.arrayBuffer();

      // ── Decode ─────────────────────────────────────────────────────────────
      upd(15, 'Decoding audio\u2026');
      const buf = await audioCtx.decodeAudioData(arrayBuf);
      if (!buf || buf.length < 1) throw new Error('Audio could not be decoded or is empty.');

      upd(20, 'Preparing analysis\u2026');
      const sr   = buf.sampleRate;
      const nCh  = Math.min(buf.numberOfChannels, 6); // ITU-R BS.1770-4 max 6 ch
      const nSmp = buf.length;
      const chs  = [];
      for (let i = 0; i < nCh; i++) chs.push(buf.getChannelData(i));

      // ITU-R BS.1770-4 channel weights: L=1, R=1, C=1, Ls=1.41, Rs=1.41, LFE=0
      const G_WEIGHT = [1.0, 1.0, 1.0, 1.41, 1.41, 0.0];

      // ── K-weight all channels — full continuous pass per channel ───────────
      upd(22, 'K-weighting channels\u2026');
      const kwChs = [];
      for (let ch = 0; ch < nCh; ch++) {
        kwChs.push(kWeightFull(chs[ch], sr));
        await new Promise(r => setTimeout(r, 0));
      }

      // ── Integrated LUFS — 400 ms blocks, 75% overlap (ITU-R BS.1770-4 §2.2)
      const blockSz = Math.floor(sr * 0.4);
      const stepSz  = Math.floor(blockSz * 0.25); // 100 ms step
      const nBlocks = Math.floor((nSmp - blockSz) / stepSz);
      if (nBlocks < 1)
        throw new Error('Track is too short for loudness analysis (minimum 400 ms).');

      const blockMS = new Float64Array(nBlocks); // per-block mean-square (K-weighted)
      const blockL  = new Float64Array(nBlocks); // per-block loudness in LUFS

      upd(25, 'Processing loudness blocks\u2026');
      for (let bi = 0; bi < nBlocks; bi++) {
        const pos = bi * stepSz;
        let ms = 0;
        for (let ch = 0; ch < nCh; ch++) {
          const w = G_WEIGHT[ch];
          if (w === 0.0) continue;
          const kw = kwChs[ch];
          let sq = 0;
          for (let i = pos, end = pos + blockSz; i < end; i++) sq += kw[i] * kw[i];
          ms += w * (sq / blockSz);
        }
        blockMS[bi] = ms;
        blockL[bi]  = ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity;
        if (bi % 200 === 0) {
          upd(25 + (bi / nBlocks) * 45, 'Block ' + bi + ' / ' + nBlocks + '\u2026');
          await new Promise(r => setTimeout(r, 0));
        }
      }

      upd(72, 'Calculating loudness metrics\u2026');

      // Absolute gate (-70 LUFS) → relative gate (mean − 10 LU) → integrated LUFS
      let gMs = 0, gN = 0;
      for (let i = 0; i < nBlocks; i++) {
        if (blockL[i] >= -70) { gMs += blockMS[i]; gN++; }
      }
      if (gN === 0)
        throw new Error('Track is below the absolute loudness gate (\u221270 LUFS). Is the file silent?');

      const relGate = -0.691 + 10 * Math.log10(gMs / gN) - 10;
      let fMs = 0, fN = 0;
      for (let i = 0; i < nBlocks; i++) {
        if (blockL[i] >= relGate) { fMs += blockMS[i]; fN++; }
      }
      const intLUFS = fN > 0 ? -0.691 + 10 * Math.log10(fMs / fN) : -100;

      // Max Momentary LUFS (peak 400 ms block)
      let maxMomentary = -100;
      for (let i = 0; i < nBlocks; i++) if (blockL[i] > maxMomentary) maxMomentary = blockL[i];

      // Short-term (3 s) windows — 30 x 100 ms steps (EBU Tech 3342 §3)
      const ST_WIN = 30;
      const stL  = [];
      const stMS = [];
      let maxShortTerm = -100;
      for (let si = 0; si + ST_WIN <= nBlocks; si++) {
        let ms = 0;
        for (let k = 0; k < ST_WIN; k++) ms += blockMS[si + k];
        ms /= ST_WIN;
        const l = ms > 0 ? -0.691 + 10 * Math.log10(ms) : -100;
        stL.push(l); stMS.push(ms);
        if (l > maxShortTerm) maxShortTerm = l;
      }

      // LRA — EBU Tech 3342 §2.3
      let lra = 0;
      const stAbsIdx = stL.map((l, i) => i).filter(i => stL[i] >= -70);
      if (stAbsIdx.length > 1) {
        const stAbsMs   = stAbsIdx.reduce((s, i) => s + stMS[i], 0) / stAbsIdx.length;
        const stRelGate = (stAbsMs > 0 ? -0.691 + 10 * Math.log10(stAbsMs) : -100) - 20;
        const relFilt   = stAbsIdx.filter(i => stL[i] >= stRelGate).map(i => stL[i]).sort((a, b) => a - b);
        if (relFilt.length > 1)
          lra = relFilt[Math.floor(relFilt.length * 0.95)] - relFilt[Math.floor(relFilt.length * 0.1)];
      }

      // Noise floor — 5th percentile of short-term gated blocks
      const stSorted  = stAbsIdx.map(i => stL[i]).sort((a, b) => a - b);
      const noiseFloor = stSorted.length > 10 ? stSorted[Math.floor(stSorted.length * 0.05)] : -100;
      const gainTo14  = -14 - intLUFS;

      // ── True Peak — 4x Catmull-Rom inter-sample (ITU-R BS.1770-4 §3) ──────
      upd(75, 'Calculating true peak\u2026');
      let truePeak = -100;
      for (let ch = 0; ch < nCh; ch++) {
        const d = chs[ch];
        const n = d.length;
        for (let i = 1; i < n - 2; i++) {
          const y1 = d[i];
          const pa = y1 < 0 ? -y1 : y1;
          if (pa > 0) {
            const db = 20 * Math.log10(pa);
            if (db > truePeak) truePeak = db;
          }
          // 4x Catmull-Rom upsampling at t = 0.25, 0.5, 0.75
          // Check near any significant sample (> 0.5 FS) to catch inter-sample peaks
          if (pa > 0.5) {
            const y0 = d[i - 1];
            const y2 = d[i + 1];
            const y3 = d[i + 2 < n ? i + 2 : n - 1];
            const c0 =  y1;
            const c1 = (-y0 + y2) * 0.5;
            const c2 =  y0 - 2.5*y1 + 2.0*y2 - 0.5*y3;
            const c3 = -0.5*y0 + 1.5*y1 - 1.5*y2 + 0.5*y3;
            for (let ti = 1; ti <= 3; ti++) {
              const t  = ti * 0.25;
              const v  = ((c3*t + c2)*t + c1)*t + c0;
              const pv = v < 0 ? -v : v;
              if (pv > pa) {
                const db = 20 * Math.log10(pv);
                if (db > truePeak) truePeak = db;
              }
            }
          }
        }
        await new Promise(r => setTimeout(r, 0));
      }

      // ── Single-pass: RMS / DC / stereo image ──────────────────────────────
      upd(80, 'Analyzing stereo image\u2026');
      const chL = chs[0], chR = nCh >= 2 ? chs[1] : chs[0];
      let sqL = 0, sqR = 0, sumL = 0, sumR = 0, sumLR = 0, sqM = 0, sqS = 0;
      for (let i = 0; i < nSmp; i++) {
        const l = chL[i], r = chR[i];
        sqL += l*l; sqR += r*r;
        sumL += l;  sumR += r;
        sumLR += l*r;
        const M = (l + r) * 0.5, S = (l - r) * 0.5;
        sqM += M*M; sqS += S*S;
        if (i % 500000 === 0 && i > 0) await new Promise(r => setTimeout(r, 0));
      }
      const rmsLVal    = Math.sqrt(sqL / nSmp);
      const rmsRVal    = Math.sqrt(sqR / nSmp);
      const rmsAvg     = nCh >= 2 ? Math.sqrt((sqL + sqR) / (2 * nSmp)) : rmsLVal;
      const rmsDb      = rmsAvg  > 1e-9  ? 20 * Math.log10(rmsAvg) : -100;
      const dcL        = (sumL / nSmp) * 100;
      const dcR        = nCh >= 2 ? (sumR / nSmp) * 100 : dcL;
      const corrDen    = Math.sqrt(sqL * sqR);
      const stereoCorr = nCh >= 2 && corrDen > 1e-12 ? Math.max(-1, Math.min(1, sumLR / corrDen)) : 1;
      const stereoWidth = nCh >= 2 && sqM > 1e-12 ? Math.min(200, Math.sqrt(sqS / sqM) * 100) : 0;
      const balanceDb  = nCh >= 2 && rmsLVal > 1e-9 && rmsRVal > 1e-9
                         ? 20 * Math.log10(rmsRVal / rmsLVal) : 0;
      const headroom   = -truePeak;
      const crestFactor = rmsDb < -99 ? 0 : truePeak - rmsDb;

      // ── Clipping detection — 100 ms windows at >= 99% full scale ──────────
      upd(84, 'Detecting clipping\u2026');
      const clipEvts = [];
      const clipStep = Math.floor(sr * 0.1);
      for (let pos = 0; pos + clipStep <= nSmp; pos += clipStep) {
        let clipped = false;
        for (let ch = 0; ch < nCh && !clipped; ch++) {
          const d = chs[ch];
          for (let i = pos, end = pos + clipStep; i < end; i++) {
            if (d[i] >= 0.99 || d[i] <= -0.99) { clipped = true; break; }
          }
        }
        if (clipped) {
          const s  = pos / sr;
          const mm = Math.floor(s / 60);
          const ss = Math.floor(s % 60);
          const cs = Math.floor((s % 1) * 100);
          clipEvts.push(mm + ':' + String(ss).padStart(2, '0') + '.' + String(cs).padStart(2, '0'));
        }
      }

      // ── Spectral analysis — power-averaged Hann-windowed 4096-pt FFT ──────
      upd(86, 'Analyzing spectral content\u2026');
      const FFT_N   = 4096, halfFFT = FFT_N >> 1;
      const hannWin = new Float32Array(FFT_N);
      for (let i = 0; i < FFT_N; i++) hannWin[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_N - 1)));
      const fftRe  = new Float32Array(FFT_N), fftIm = new Float32Array(FFT_N);
      const avgPow = new Float64Array(halfFFT); // accumulated power (|X|^2)
      const specSrc = chs[0];
      const hopSamp = Math.max(Math.floor(sr * 0.5), FFT_N); // 500 ms hop
      let fftCount  = 0;
      for (let w = 0; w + FFT_N <= specSrc.length; w += hopSamp) {
        for (let i = 0; i < FFT_N; i++) { fftRe[i] = specSrc[w + i] * hannWin[i]; fftIm[i] = 0; }
        computeFFT(fftRe, fftIm);
        for (let i = 0; i < halfFFT; i++) avgPow[i] += fftRe[i]*fftRe[i] + fftIm[i]*fftIm[i];
        fftCount++;
        if (fftCount % 20 === 0) await new Promise(r => setTimeout(r, 0));
      }
      if (fftCount > 0) for (let i = 0; i < halfFFT; i++) avgPow[i] /= fftCount;

      // Spectral centroid — power-weighted mean frequency
      let powSum = 0, freqPowSum = 0;
      for (let i = 1; i < halfFFT; i++) {
        const f = i * sr / FFT_N;
        powSum += avgPow[i]; freqPowSum += f * avgPow[i];
      }
      const spectralCentroid = powSum > 0 ? freqPowSum / powSum : 0;

      // Dominant frequency — peak bin above 20 Hz
      const minBin = Math.max(1, Math.ceil(20 * FFT_N / sr));
      let peakBin  = minBin;
      for (let i = minBin + 1; i < halfFFT; i++) if (avgPow[i] > avgPow[peakBin]) peakBin = i;
      const dominantFreq = peakBin * sr / FFT_N;

      // Band energy percentages (power)
      const bands = [
        { label: 'Sub Bass', lo: 20,   hi: 80    },
        { label: 'Bass',     lo: 80,   hi: 250   },
        { label: 'Low Mids', lo: 250,  hi: 800   },
        { label: 'Mids',     lo: 800,  hi: 2500  },
        { label: 'Hi Mids',  lo: 2500, hi: 5000  },
        { label: 'Air',      lo: 5000, hi: 20000 },
      ];
      let totalBandE = 0;
      bands.forEach(b => {
        const lo = Math.max(1, Math.floor(b.lo * FFT_N / sr));
        const hi = Math.min(halfFFT - 1, Math.ceil(b.hi * FFT_N / sr));
        b.energy = 0;
        for (let i = lo; i <= hi; i++) b.energy += avgPow[i];
        totalBandE += b.energy;
      });
      bands.forEach(b => { b.pct = totalBandE > 0 ? Math.round(b.energy / totalBandE * 100) : 0; });

      // ── BPM — onset-strength autocorrelation, middle 60% of track ─────────
      upd(91, 'Detecting tempo\u2026');
      let detBPM = 0;
      {
        const bpmSrc   = chs[0];
        const bpmStart = Math.floor(bpmSrc.length * 0.20);
        const bpmEnd   = Math.floor(bpmSrc.length * 0.80);
        const ENV_HOP  = 512;
        const nEnv     = Math.floor((bpmEnd - bpmStart) / ENV_HOP);

        // RMS energy envelope
        const envCurve = new Float32Array(nEnv);
        for (let f = 0; f < nEnv; f++) {
          let e = 0;
          const off = bpmStart + f * ENV_HOP;
          for (let i = 0; i < ENV_HOP; i++) { const s = bpmSrc[off + i] || 0; e += s * s; }
          envCurve[f] = Math.sqrt(e / ENV_HOP);
        }

        // Onset strength — half-wave rectified log-energy first difference
        const EPS  = 1e-10;
        const nOns = nEnv - 1;
        const ons  = new Float32Array(nOns);
        for (let i = 0; i < nOns; i++) {
          const diff = Math.log(envCurve[i + 1] + EPS) - Math.log(envCurve[i] + EPS);
          ons[i] = diff > 0 ? diff : 0;
        }
        let onsPk = 0;
        for (let i = 0; i < nOns; i++) if (ons[i] > onsPk) onsPk = ons[i];
        if (onsPk > 0) for (let i = 0; i < nOns; i++) ons[i] /= onsPk;

        // Autocorrelation over 55–210 BPM search range
        const envFR = sr / ENV_HOP;
        const lagLo = Math.max(1, Math.floor(envFR * 60 / 210));
        const lagHi = Math.min(nOns - 1, Math.ceil(envFR * 60 / 55));
        let bLag = lagLo, bAC = -1;
        for (let lag = lagLo; lag <= lagHi; lag++) {
          let c = 0;
          const n = nOns - lag;
          for (let i = 0; i < n; i++) c += ons[i] * ons[i + lag];
          c /= n;
          if (c > bAC) { bAC = c; bLag = lag; }
        }

        detBPM = envFR * 60 / bLag;
        // Octave correction — prefer range 70–175 BPM
        while (detBPM < 70)  detBPM *= 2;
        while (detBPM > 175) detBPM /= 2;
      }

      // ── Key — Krumhansl-Schmuckler (1990) with power-spectrum chroma ───────
      upd(94, 'Detecting key\u2026');
      const ksMajor   = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
      const ksMinor   = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
      const noteNames = ['C','C\u266f','D','D\u266f','E','F','F\u266f','G','G\u266f','A','A\u266f','B'];
      const chroma    = new Float64Array(12);
      for (let i = 1; i < halfFFT; i++) {
        const f = i * sr / FFT_N;
        if (f < 27.5 || f > 4200) continue;
        const pc = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12;
        chroma[pc] += avgPow[i]; // power-weighted chroma for accuracy
      }
      let chMax = 0;
      for (let i = 0; i < 12; i++) if (chroma[i] > chMax) chMax = chroma[i];
      if (chMax > 0) for (let i = 0; i < 12; i++) chroma[i] /= chMax;

      function ksPearson(v, p) {
        let sv = 0, sp = 0, svp = 0, sv2 = 0, sp2 = 0;
        for (let i = 0; i < 12; i++) {
          sv += v[i]; sp += p[i]; svp += v[i]*p[i]; sv2 += v[i]*v[i]; sp2 += p[i]*p[i];
        }
        const num = 12*svp - sv*sp;
        const den = Math.sqrt((12*sv2 - sv*sv) * (12*sp2 - sp*sp));
        return den > 0 ? num / den : 0;
      }

      let bestKey = 'C', bestMode = 'major', bestKC = -2;
      const rot = new Float64Array(12);
      for (let r = 0; r < 12; r++) {
        for (let i = 0; i < 12; i++) rot[i] = chroma[(i + r) % 12];
        const mj = ksPearson(rot, ksMajor), mn = ksPearson(rot, ksMinor);
        if (mj > bestKC) { bestKC = mj; bestKey = noteNames[r]; bestMode = 'major'; }
        if (mn > bestKC) { bestKC = mn; bestKey = noteNames[r]; bestMode = 'minor'; }
      }
      const keyConf = Math.round(Math.max(0, Math.min(100, (bestKC + 1) * 50)));
      const keyTag  = keyConf >= 70 ? 'good' : keyConf >= 45 ? 'info' : 'warn-text';

      // ── Streaming compliance ───────────────────────────────────────────────
      const PLATFORMS = [
        { name: 'Spotify',      lufs: -14, tp: -1 },
        { name: 'Apple Music',  lufs: -16, tp: -1 },
        { name: 'YouTube',      lufs: -14, tp: -1 },
        { name: 'Amazon Music', lufs: -14, tp: -2 },
        { name: 'Tidal',        lufs: -14, tp: -1 },
        { name: 'Deezer',       lufs: -15, tp: -1 },
        { name: 'SoundCloud',   lufs: -14, tp: -1 },
        { name: 'Broadcast',    lufs: -23, tp: -1 },
      ];

      upd(98, 'Building report\u2026');
      await new Promise(r => setTimeout(r, 0));

      // ── Build result HTML ─────────────────────────────────────────────────
      const inf = '\u2212\u221e';

      const gainStr = Math.abs(gainTo14) < 0.1 ? 'On target'
        : gainTo14 > 0 ? '+' + gainTo14.toFixed(1) + ' dB needed'
        : gainTo14.toFixed(1) + ' dB (will be reduced)';

      let crestLabel, crestCls;
      if      (crestFactor > 20) { crestLabel = 'Excellent dynamics';   crestCls = 'good'; }
      else if (crestFactor > 14) { crestLabel = 'Good dynamics';        crestCls = 'good'; }
      else if (crestFactor > 8)  { crestLabel = 'Moderate compression'; crestCls = 'good'; }
      else                       { crestLabel = 'Heavy limiting';       crestCls = 'warn-text'; }

      const clipSection = clipEvts.length > 0
        ? '<div class="analysis-metric" style="border-left-color:#ff6b6b;">'
          + '<span class="analysis-label" style="color:#ff6b6b;">Clipping Events:</span>'
          + '<span class="analysis-value" style="color:#ff6b6b;">' + clipEvts.length + ' detected</span></div>'
          + '<div class="analysis-clipping-log"><div class="analysis-clipping-header">Timestamps (mm:ss.cs):</div>'
          + '<div class="analysis-clipping-events">'
          + clipEvts.map(t => '<div class="analysis-clipping-event">' + t + '</div>').join('')
          + '</div></div>'
        : '<div class="analysis-metric" style="border-left-color:#7ec98f;">'
          + '<span class="analysis-label" style="color:#7ec98f;">Clipping Events:</span>'
          + '<span class="analysis-value" style="color:#7ec98f;">None detected \u2713</span></div>';

      let corrLabel, corrCls;
      if      (stereoCorr > 0.95) { corrLabel = 'Mono-like';    corrCls = 'info'; }
      else if (stereoCorr > 0.70) { corrLabel = 'Narrow';       corrCls = 'good'; }
      else if (stereoCorr > 0.30) { corrLabel = 'Good stereo';  corrCls = 'good'; }
      else if (stereoCorr >= 0)   { corrLabel = 'Wide stereo';  corrCls = 'good'; }
      else                        { corrLabel = 'Phase issues'; corrCls = 'warn-text'; }
      const monoWarnHTML = stereoCorr < 0
        ? '<div class="analysis-warn">\u26a0 Negative correlation \u2014 signal may partially cancel on mono playback.</div>' : '';
      const balLabel = Math.abs(balanceDb) < 0.3
        ? 'Centered' : (balanceDb > 0 ? 'R' : 'L') + ' +' + Math.abs(balanceDb).toFixed(1) + ' dB';
      const stereoSection = nCh >= 2
        ? '<div class="analysis-section-header">STEREO IMAGE</div>'
          + '<div class="analysis-metric"><span class="analysis-label">Correlation:</span>'
          + '<span class="analysis-value">' + stereoCorr.toFixed(3)
          + ' <span class="analysis-tag ' + corrCls + '">' + corrLabel + '</span></span></div>'
          + '<div class="analysis-metric"><span class="analysis-label">Stereo Width:</span>'
          + '<span class="analysis-value">' + stereoWidth.toFixed(1) + '%</span></div>'
          + '<div class="analysis-metric"><span class="analysis-label">L/R Balance:</span>'
          + '<span class="analysis-value">' + balLabel + '</span></div>'
          + monoWarnHTML
        : '';

      let centroidLabel;
      if      (spectralCentroid < 1500) centroidLabel = 'Dark / warm';
      else if (spectralCentroid < 3000) centroidLabel = 'Balanced';
      else if (spectralCentroid < 5000) centroidLabel = 'Present / forward';
      else                              centroidLabel = 'Bright';
      const domFreqStr = dominantFreq < 1000
        ? Math.round(dominantFreq) + ' Hz' : (dominantFreq / 1000).toFixed(2) + ' kHz';

      const bandBarsHTML = bands.map(b =>
        '<div class="analysis-band-row">'
        + '<span class="analysis-band-label">' + b.label + '</span>'
        + '<div class="analysis-band-bar-outer"><div class="analysis-band-bar-inner" style="width:'
        + Math.min(100, b.pct * 2) + '%"></div></div>'
        + '<span class="analysis-band-pct">' + b.pct + '%</span></div>'
      ).join('');

      function fmtDC(v) {
        const s = (v >= 0 ? '+' : '') + v.toFixed(4) + '%';
        return Math.abs(v) > 0.1 ? '<span style="color:#ffc850">' + s + ' \u26a0</span>' : s;
      }
      const dcOffsetHTML = nCh >= 2
        ? '<div class="analysis-metric"><span class="analysis-label">DC Offset L:</span>'
          + '<span class="analysis-value">' + fmtDC(dcL) + '</span></div>'
          + '<div class="analysis-metric"><span class="analysis-label">DC Offset R:</span>'
          + '<span class="analysis-value">' + fmtDC(dcR) + '</span></div>'
        : '<div class="analysis-metric"><span class="analysis-label">DC Offset:</span>'
          + '<span class="analysis-value">' + fmtDC(dcL) + '</span></div>';

      const complianceRows = PLATFORMS.map(p => {
        const delta  = intLUFS - p.lufs; // positive = over target
        const tpPass = truePeak <= p.tp;
        let status, cls;
        if      (Math.abs(delta) <= 1.0 && tpPass)  { status = '\u2713 Pass';                              cls = 'good'; }
        else if (delta > 1.0 && tpPass)              { status = '\u2193 ' + delta.toFixed(1) + ' LU over'; cls = 'warn-text'; }
        else if (!tpPass && Math.abs(delta) <= 1.0)  { status = '\u26a0 Peak limit';                       cls = 'warn-text'; }
        else if (!tpPass)                            { status = '\u2717 Fail (peak + level)';              cls = 'warn-text'; }
        else                                         { status = '\u2191 ' + Math.abs(delta).toFixed(1) + ' LU under'; cls = 'info'; }
        const adj    = p.lufs - intLUFS;
        const adjStr = Math.abs(adj) < 0.05 ? 'On target'
          : adj > 0 ? '+' + adj.toFixed(1) + ' dB' : adj.toFixed(1) + ' dB';
        return '<div class="analysis-metric"><span class="analysis-label">' + p.name + ':</span>'
          + '<span class="analysis-value"><span class="analysis-tag ' + cls + '">' + status + '</span>'
          + ' &mdash; target ' + p.lufs + ' LUFS / ' + p.tp + ' dBTP'
          + ' &mdash; adjust: ' + adjStr + '</span></div>';
      }).join('');

      const chLabel = nCh === 1 ? 'Mono' : nCh === 2 ? 'Stereo' : nCh + '-channel';
      const dur     = buf.duration;

      upd(100, 'Complete!');
      await new Promise(r => setTimeout(r, 150));

      resultsEl.innerHTML = `
        <div class="analysis-track-name">${trackName}</div>

        <div class="analysis-section-header">LOUDNESS</div>
        <div class="analysis-metric">
          <span class="analysis-label">Integrated LUFS:</span>
          <span class="analysis-value">${intLUFS > -99 ? intLUFS.toFixed(1) + ' LUFS' : inf + ' LUFS'}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Max Momentary:</span>
          <span class="analysis-value">${maxMomentary > -99 ? maxMomentary.toFixed(1) + ' LUFS' : inf + ' LUFS'}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Max Short-term:</span>
          <span class="analysis-value">${maxShortTerm > -99 ? maxShortTerm.toFixed(1) + ' LUFS' : inf + ' LUFS'}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Loudness Range (LRA):</span>
          <span class="analysis-value">${lra.toFixed(1)} LU</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Noise Floor:</span>
          <span class="analysis-value">${noiseFloor > -99 ? noiseFloor.toFixed(1) + ' LUFS' : inf + ' LUFS'}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Gain to \u221214 LUFS:</span>
          <span class="analysis-value">${gainStr}</span>
        </div>

        <div class="analysis-section-header">LEVELS &amp; DYNAMICS</div>
        <div class="analysis-metric">
          <span class="analysis-label">RMS Level:</span>
          <span class="analysis-value">${rmsDb > -99 ? rmsDb.toFixed(1) + ' dBFS' : inf + ' dBFS'}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">True Peak:</span>
          <span class="analysis-value">${truePeak > -99 ? truePeak.toFixed(1) + ' dBTP' : inf + ' dBTP'}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Headroom:</span>
          <span class="analysis-value">${headroom.toFixed(1)} dB</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Crest Factor:</span>
          <span class="analysis-value">${crestFactor.toFixed(1)} dB <span class="analysis-tag ${crestCls}">${crestLabel}</span></span>
        </div>
        ${clipSection}

        ${stereoSection}

        <div class="analysis-section-header">SPECTRAL CHARACTER</div>
        <div class="analysis-metric">
          <span class="analysis-label">Spectral Centroid:</span>
          <span class="analysis-value">${Math.round(spectralCentroid)} Hz <span class="analysis-tag good">${centroidLabel}</span></span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Dominant Frequency:</span>
          <span class="analysis-value">${domFreqStr}</span>
        </div>
        <div class="analysis-band-bars">${bandBarsHTML}</div>

        <div class="analysis-section-header">TEMPO &amp; KEY</div>
        <div class="analysis-metric">
          <span class="analysis-label">BPM:</span>
          <span class="analysis-value">${detBPM.toFixed(1)}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Key:</span>
          <span class="analysis-value">${bestKey} ${bestMode} <span class="analysis-tag ${keyTag}">${keyConf}% confidence</span></span>
        </div>

        <div class="analysis-section-header">STREAMING COMPLIANCE</div>
        ${complianceRows}

        <div class="analysis-section-header">FILE INFO</div>
        <div class="analysis-metric">
          <span class="analysis-label">Duration:</span>
          <span class="analysis-value">${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Sample Rate:</span>
          <span class="analysis-value">${(sr / 1000).toFixed(1)} kHz</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Channels:</span>
          <span class="analysis-value">${chLabel}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Total Samples:</span>
          <span class="analysis-value">${(buf.length / 1e6).toFixed(2)} M</span>
        </div>
        ${dcOffsetHTML}
      `;

    } catch (err) {
      resultsEl.innerHTML =
        '<div class="analysis-error">'
        + '<strong>Analysis Failed</strong><br>'
        + err.message + '<br>'
        + '<span style="font-size:0.85em;opacity:0.6">Ensure the track is fully loaded before analyzing.</span>'
        + '</div>';
    } finally {
      audioCtx.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Public API — must be called synchronously from a user-gesture handler
  // ---------------------------------------------------------------------------
  function run(audioUrl, trackName, resultsEl) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    resultsEl.innerHTML =
      '<div class="analysis-loading">'
      + '<span class="analysis-loading-text">Analyzing track</span>'
      + '<span class="analysis-loading-dots"><span>.</span><span>.</span><span>.</span></span>'
      + '<div class="analysis-loading-subtext">This may take a minute for long files</div>'
      + '<div class="analysis-progress"><div class="analysis-progress-bar"></div></div>'
      + '<div class="analysis-progress-text">0%</div>'
      + '</div>';

    _analyse(audioCtx, audioUrl, trackName, resultsEl);
  }

  return { run: run };

})();
