/* =============================================================================
   analyzer.js — Universal audio analysis engine — Audio Design Studios
   Full offline track analysis: K-weighted LUFS, True Peak (4x), LRA, BPM,
   key detection, spectral FFT, stereo image, DC offset, clipping events, and
   8-platform streaming compliance table.

   Public API:
     AudioAnalyzer.run(audioUrl, trackName, resultsEl)
       audioUrl  – HTTP/blob/object URL for the audio file
       trackName – display name shown inside the results
       resultsEl – DOM element that receives the loading indicator and results

   IMPORTANT: call run() directly from a click-handler (or other user-gesture
   handler) so the AudioContext is created inside the activation window.
   ============================================================================= */

window.AudioAnalyzer = (function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // K-weighting pre-filter — ITU-R BS.1770-4
  // Stage 1: high-shelf (~1.7 kHz, outer-ear / head diffraction)
  // Stage 2: high-pass (~38 Hz, RLB weighting / free-field transfer)
  // ---------------------------------------------------------------------------
  function kWeightChannel(data, fs) {
    const f0s = 1681.974450955533, Gs = 3.999843853973347, Qs = 0.7071752369554196;
    const Ks  = Math.tan(Math.PI * f0s / fs);
    const Vh  = Math.pow(10, Gs / 20);
    const Vb  = Math.pow(Vh, 0.4996667741545416);
    const den = 1 + Ks / Qs + Ks * Ks;
    const bs0 = (Vh + Vb * Ks / Qs + Ks * Ks) / den;
    const bs1 = 2 * (Ks * Ks - Vh) / den;
    const bs2 = (Vh - Vb * Ks / Qs + Ks * Ks) / den;
    const as1 = 2 * (Ks * Ks - 1) / den;
    const as2 = (1 - Ks / Qs + Ks * Ks) / den;

    const f0h = 38.13547087602444, Qh = 0.5003270373238773;
    const Kh  = Math.tan(Math.PI * f0h / fs);
    const dh  = 1 + Kh / Qh + Kh * Kh;
    const bh0 = 1 / dh, bh1 = -2 / dh, bh2 = 1 / dh;
    const ah1 = 2 * (Kh * Kh - 1) / dh;
    const ah2 = (1 - Kh / Qh + Kh * Kh) / dh;

    function biquad(inp, b0, b1, b2, a1, a2) {
      const out = new Float32Array(inp.length);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < inp.length; i++) {
        const x0 = inp[i];
        const y0 = b0*x0 + b1*x1 + b2*x2 - a1*y1 - a2*y2;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        out[i] = y0;
      }
      return out;
    }
    return biquad(biquad(data, bs0, bs1, bs2, as1, as2), bh0, bh1, bh2, ah1, ah2);
  }

  // ---------------------------------------------------------------------------
  // Radix-2 in-place Cooley-Tukey FFT (length must be power-of-two)
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
  // Core async analysis — AudioContext is already created by the caller
  // ---------------------------------------------------------------------------
  async function _analyse(audioCtx, audioUrl, trackName, resultsEl) {

    function upd(pct, label) {
      const bar = resultsEl.querySelector('.analysis-progress-bar');
      const txt = resultsEl.querySelector('.analysis-progress-text');
      if (bar) bar.style.width = pct + '%';
      if (txt) txt.textContent = label || Math.round(pct) + '%';
    }

    try {
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      // ── Fetch ────────────────────────────────────────────────────────────────
      upd(5, 'Fetching audio\u2026');
      const resp = await fetch(encodeURI(audioUrl));
      if (!resp.ok) throw new Error('Fetch failed: ' + resp.status + ' ' + resp.statusText);
      const arrayBuf = await resp.arrayBuffer();

      // ── Decode ───────────────────────────────────────────────────────────────
      upd(15, 'Decoding audio\u2026');
      const buf = await audioCtx.decodeAudioData(arrayBuf);
      if (!buf || !buf.length) throw new Error('Audio could not be decoded or is empty');

      upd(25, 'Preparing analysis\u2026');
      const sr    = buf.sampleRate;
      const nCh   = buf.numberOfChannels;
      const chs   = [];
      for (let i = 0; i < nCh; i++) chs.push(buf.getChannelData(i));

      // ── Integrated LUFS — 400ms blocks, 75% overlap (ITU-R BS.1770-4) ───────
      const blockSize    = Math.floor(sr * 0.4);
      const step         = Math.floor(blockSize * 0.25);
      const allBlocks    = [];
      const totalBlocks  = Math.floor((chs[0].length - blockSize) / step);
      let doneBlocks     = 0;
      const chWeights    = [1.0, 1.0, 1.0, 1.41, 1.41, 1.0]; // ITU-R BS.1770 G weights

      upd(30, 'Processing blocks\u2026');
      for (let pos = 0; pos < chs[0].length - blockSize; pos += step) {
        let sumMs = 0;
        for (let ch = 0; ch < nCh; ch++) {
          const kw = kWeightChannel(chs[ch].slice(pos, pos + blockSize), sr);
          let sq = 0;
          for (let i = 0; i < blockSize; i++) sq += kw[i] * kw[i];
          sumMs += (chWeights[ch] || 1.0) * (sq / blockSize);
        }
        allBlocks.push({ loudness: -0.691 + 10 * Math.log10(sumMs), meanSquare: sumMs });
        doneBlocks++;
        if (doneBlocks % 100 === 0 || doneBlocks === totalBlocks) {
          upd(30 + (doneBlocks / totalBlocks) * 50,
              'Processing ' + doneBlocks + '/' + totalBlocks + ' blocks\u2026');
          await new Promise(r => setTimeout(r, 0));
        }
      }

      upd(85, 'Calculating metrics\u2026');

      // Absolute gate → relative gate → integrated LUFS
      let gMs = 0, gN = 0;
      allBlocks.forEach(b => { if (b.loudness >= -70) { gMs += b.meanSquare; gN++; } });
      if (!gN) throw new Error('No blocks above absolute gate (-70 LUFS)');
      const gL   = -0.691 + 10 * Math.log10(gMs / gN);
      const relG = gL - 10;
      let fMs = 0, fN = 0;
      allBlocks.forEach(b => { if (b.loudness >= relG) { fMs += b.meanSquare; fN++; } });
      const intLUFS = fN > 0 ? -0.691 + 10 * Math.log10(fMs / fN) : -100;

      // ── True Peak — 4x Catmull-Rom inter-sample (ITU-R BS.1770-4) ───────────
      upd(87, 'Calculating true peak\u2026');
      let truePeak = -100;
      for (let ch = 0; ch < nCh; ch++) {
        const d = chs[ch], n = d.length;
        for (let i = 1; i < n - 2; i++) {
          const y1 = d[i], pa = y1 < 0 ? -y1 : y1;
          if (pa > 0) { const db = 20 * Math.log10(pa); if (db > truePeak) truePeak = db; }
          if (pa > 0.9) {
            const y0 = d[i-1], y2 = d[i+1], y3 = d[i+2];
            const c0 = y1;
            const c1 = -0.5*y0 + 0.5*y2;
            const c2 =  y0 - 2.5*y1 + 2.0*y2 - 0.5*y3;
            const c3 = -0.5*y0 + 1.5*y1 - 1.5*y2 + 0.5*y3;
            for (let ti = 1; ti <= 3; ti++) {
              const t = ti * 0.25, v = ((c3*t + c2)*t + c1)*t + c0;
              const pv = v < 0 ? -v : v;
              if (pv > 0) { const db = 20 * Math.log10(pv); if (db > truePeak) truePeak = db; }
            }
          }
        }
      }

      // Max Momentary (peak 400ms block)
      const maxMomentary = allBlocks.reduce((mx, b) => Math.max(mx, b.loudness), -100);

      // ── Short-term (3s) blocks → maxST + LRA (EBU Tech 3342) ────────────────
      const stBlocks = [];
      let maxShortTerm = -100;
      const ST_WIN = 30;
      for (let si = 0; si <= allBlocks.length - ST_WIN; si++) {
        let stMs = 0;
        for (let k = 0; k < ST_WIN; k++) stMs += allBlocks[si + k].meanSquare;
        stMs /= ST_WIN;
        const stL = -0.691 + 10 * Math.log10(stMs);
        stBlocks.push({ loudness: stL, meanSquare: stMs });
        if (stL > maxShortTerm) maxShortTerm = stL;
      }
      const stAbsGated = stBlocks.filter(b => b.loudness >= -70);
      let lra = 0;
      if (stAbsGated.length > 1) {
        const lraAbsMs = stAbsGated.reduce((s, b) => s + b.meanSquare, 0) / stAbsGated.length;
        const lraAbsL  = -0.691 + 10 * Math.log10(lraAbsMs);
        const lraFilt  = stAbsGated
          .filter(b => b.loudness >= lraAbsL - 20)
          .map(b => b.loudness)
          .sort((a, b) => a - b);
        if (lraFilt.length > 1)
          lra = lraFilt[Math.floor(lraFilt.length * 0.95)] - lraFilt[Math.floor(lraFilt.length * 0.1)];
      }

      // Noise floor — 5th percentile of 3s blocks above absolute gate
      const stSorted  = stAbsGated.map(b => b.loudness).sort((a, b) => a - b);
      const noiseFloor = stSorted.length > 10 ? stSorted[Math.floor(stSorted.length * 0.05)] : -100;
      const gainToTgt  = -14 - intLUFS;

      // ── Single-pass: RMS / DC / stereo correlation / width / balance ─────────
      upd(89, 'Analyzing stereo image\u2026');
      const nSmp = chs[0].length;
      const chL  = chs[0], chR = nCh >= 2 ? chs[1] : chs[0];
      let sqL = 0, sqR = 0, sumL = 0, sumR = 0, sumLR = 0, sqM = 0, sqS = 0;
      for (let i = 0; i < nSmp; i++) {
        const l = chL[i], r = chR[i];
        sqL += l*l; sqR += r*r; sumL += l; sumR += r; sumLR += l*r;
        const M = (l+r)*0.5, Sv = (l-r)*0.5; sqM += M*M; sqS += Sv*Sv;
        if (i % 500000 === 0 && i > 0) await new Promise(res => setTimeout(res, 0));
      }
      const rmsLVal    = Math.sqrt(sqL / nSmp);
      const rmsRVal    = Math.sqrt(sqR / nSmp);
      const rmsAvg     = nCh >= 2 ? Math.sqrt((sqL + sqR) / (2 * nSmp)) : rmsLVal;
      const rmsDb      = rmsAvg > 0.00001 ? 20 * Math.log10(rmsAvg) : -100;
      const dcL        = (sumL / nSmp) * 100;
      const dcR        = nCh >= 2 ? (sumR / nSmp) * 100 : dcL;
      const corrDen    = Math.sqrt(sqL * sqR);
      const stereoCorr = nCh >= 2 && corrDen > 0 ? Math.max(-1, Math.min(1, sumLR / corrDen)) : 1;
      const stereoWidth = nCh >= 2 && sqM > 0 ? Math.min(200, Math.sqrt(sqS / sqM) * 100) : 0;
      const balanceDb   = nCh >= 2 && rmsLVal > 0.00001 && rmsRVal > 0.00001
                          ? 20 * Math.log10(rmsRVal / rmsLVal) : 0;
      const headroom    = 0 - truePeak;
      const crestFactor = truePeak - rmsDb;

      // ── Clipping events — 100ms windows at 99% full scale ───────────────────
      upd(91, 'Detecting clipping\u2026');
      const clipThr   = 0.99;
      const clipEvts  = [];
      const spCk      = Math.floor(sr * 0.1);
      for (let pos = 0; pos < chs[0].length; pos += spCk) {
        const end = Math.min(pos + spCk, chs[0].length);
        let has = false;
        for (let ch = 0; ch < nCh && !has; ch++)
          for (let i = pos; i < end; i++) if (Math.abs(chs[ch][i]) >= clipThr) { has = true; break; }
        if (has) {
          const s = pos / sr;
          clipEvts.push(Math.floor(s / 60) + ':' + (s % 60).toFixed(2).padStart(5, '0'));
        }
      }

      // ── Spectral analysis — averaged 4096-pt Hann-windowed FFT ──────────────
      upd(93, 'Analyzing spectral content\u2026');
      const FFT_N   = 4096, halfFFT = FFT_N >> 1;
      const hannWin = new Float32Array(FFT_N);
      for (let i = 0; i < FFT_N; i++) hannWin[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_N - 1)));
      const fftRe = new Float32Array(FFT_N), fftIm = new Float32Array(FFT_N);
      const avgMag = new Float64Array(halfFFT);
      const specSrc = chs[0];
      const hopSamps = Math.floor(sr);
      let fftCount = 0;
      for (let w = 0; w + FFT_N < specSrc.length; w += hopSamps) {
        for (let i = 0; i < FFT_N; i++) { fftRe[i] = specSrc[w + i] * hannWin[i]; fftIm[i] = 0; }
        computeFFT(fftRe, fftIm);
        for (let i = 0; i < halfFFT; i++) avgMag[i] += Math.sqrt(fftRe[i]*fftRe[i] + fftIm[i]*fftIm[i]);
        fftCount++;
        if (fftCount % 30 === 0) await new Promise(r => setTimeout(r, 0));
      }
      if (fftCount > 0) for (let i = 0; i < halfFFT; i++) avgMag[i] /= fftCount;

      let magSum = 0, freqWtdSum = 0;
      for (let i = 1; i < halfFFT; i++) {
        const f = i * sr / FFT_N; magSum += avgMag[i]; freqWtdSum += f * avgMag[i];
      }
      const spectralCentroid = magSum > 0 ? freqWtdSum / magSum : 0;
      const minBin = Math.max(1, Math.ceil(20 * FFT_N / sr));
      let peakBin = minBin;
      for (let i = minBin + 1; i < halfFFT; i++) if (avgMag[i] > avgMag[peakBin]) peakBin = i;
      const dominantFreq = peakBin * sr / FFT_N;

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
        for (let i = lo; i <= hi; i++) b.energy += avgMag[i] * avgMag[i];
        totalBandE += b.energy;
      });
      bands.forEach(b => { b.pct = totalBandE > 0 ? Math.round(b.energy / totalBandE * 100) : 0; });

      // ── BPM — energy envelope autocorrelation ────────────────────────────────
      upd(95, 'Detecting tempo & key\u2026');
      const envHop = 512, src = chs[0], nEnv = Math.floor(src.length / envHop);
      const envCurve = new Float32Array(nEnv);
      for (let f = 0; f < nEnv; f++) {
        let e = 0, off = f * envHop;
        for (let i = 0; i < envHop; i++) { const s = src[off + i] || 0; e += s * s; }
        envCurve[f] = Math.sqrt(e / envHop);
      }
      const nOns = nEnv - 1, ons = new Float32Array(nOns);
      for (let i = 0; i < nOns; i++) { const d = envCurve[i+1] - envCurve[i]; ons[i] = d > 0 ? d : 0; }
      let onsPk = 0;
      for (let i = 0; i < nOns; i++) if (ons[i] > onsPk) onsPk = ons[i];
      if (onsPk > 0) for (let i = 0; i < nOns; i++) ons[i] /= onsPk;
      const envFR = sr / envHop;
      const lagLo = Math.max(1, Math.floor(envFR * 60 / 210));
      const lagHi = Math.min(nOns - 1, Math.ceil(envFR * 60 / 55));
      let bLag = lagLo, bAC = -1;
      for (let lag = lagLo; lag <= lagHi; lag++) {
        let c = 0, n = nOns - lag;
        for (let i = 0; i < n; i++) c += ons[i] * ons[i + lag];
        c /= n;
        if (c > bAC) { bAC = c; bLag = lag; }
      }
      let detBPM = envFR * 60 / bLag;
      while (detBPM < 70)  detBPM *= 2;
      while (detBPM > 175) detBPM /= 2;

      // ── Key — Krumhansl-Schmuckler (1990) profiles ───────────────────────────
      const ksMajor   = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
      const ksMinor   = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
      const noteNames = ['C','C\u266f','D','D\u266f','E','F','F\u266f','G','G\u266f','A','A\u266f','B'];
      const chroma = new Float64Array(12);
      for (let i = 1; i < halfFFT; i++) {
        const f = i * sr / FFT_N;
        if (f < 27.5 || f > 4200) continue;
        const pc = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12;
        chroma[pc] += avgMag[i];
      }
      let chMax = 0;
      for (let i = 0; i < 12; i++) if (chroma[i] > chMax) chMax = chroma[i];
      if (chMax > 0) for (let i = 0; i < 12; i++) chroma[i] /= chMax;
      function ksPearson(v, p) {
        let sv=0,sp=0,svp=0,sv2=0,sp2=0;
        for (let i=0;i<12;i++){sv+=v[i];sp+=p[i];svp+=v[i]*p[i];sv2+=v[i]*v[i];sp2+=p[i]*p[i];}
        const num=12*svp-sv*sp, den=Math.sqrt((12*sv2-sv*sv)*(12*sp2-sp*sp));
        return den > 0 ? num / den : 0;
      }
      let bestKey = 'C', bestMode = 'major', bestKC = -2;
      for (let r = 0; r < 12; r++) {
        const rot = new Float64Array(12);
        for (let i = 0; i < 12; i++) rot[i] = chroma[(i + r) % 12];
        const mj = ksPearson(rot, ksMajor), mn = ksPearson(rot, ksMinor);
        if (mj > bestKC) { bestKC = mj; bestKey = noteNames[r]; bestMode = 'major'; }
        if (mn > bestKC) { bestKC = mn; bestKey = noteNames[r]; bestMode = 'minor'; }
      }
      const keyConf = Math.round(Math.max(0, Math.min(100, (bestKC + 1) * 50)));
      const keyTag  = keyConf >= 70 ? 'good' : keyConf >= 45 ? 'info' : 'warn-text';

      // ── Build result HTML ─────────────────────────────────────────────────────
      let corrLabel, corrCls;
      if      (stereoCorr > 0.95) { corrLabel = 'Mono-like';     corrCls = 'info'; }
      else if (stereoCorr > 0.70) { corrLabel = 'Narrow stereo'; corrCls = 'good'; }
      else if (stereoCorr > 0.30) { corrLabel = 'Good stereo';   corrCls = 'good'; }
      else if (stereoCorr >= 0)   { corrLabel = 'Wide stereo';   corrCls = 'good'; }
      else                        { corrLabel = 'Phase issues';   corrCls = 'warn-text'; }
      const monoWarnHTML = stereoCorr < 0
        ? '<div class="analysis-warn">\u26a0 Negative correlation \u2014 signal may cancel on mono playback</div>' : '';
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

      let crestLabel, crestCls;
      if      (crestFactor > 20) { crestLabel = 'Excellent dynamics';   crestCls = 'good'; }
      else if (crestFactor > 14) { crestLabel = 'Good dynamics';        crestCls = 'good'; }
      else if (crestFactor > 8)  { crestLabel = 'Moderate compression'; crestCls = 'good'; }
      else                       { crestLabel = 'Heavy limiting';       crestCls = 'warn-text'; }

      let centroidLabel;
      if      (spectralCentroid < 1500) centroidLabel = 'Dark / warm';
      else if (spectralCentroid < 3000) centroidLabel = 'Balanced';
      else if (spectralCentroid < 5000) centroidLabel = 'Forward / present';
      else                              centroidLabel = 'Bright';
      const domFreqStr = dominantFreq < 1000
        ? Math.round(dominantFreq) + ' Hz' : (dominantFreq / 1000).toFixed(2) + ' kHz';

      const bandBarsHTML = bands.map(b =>
        '<div class="analysis-band-row">'
        + '<span class="analysis-band-label">' + b.label + '</span>'
        + '<div class="analysis-band-bar-outer">'
        + '<div class="analysis-band-bar-inner" style="width:' + Math.min(100, b.pct * 2) + '%"></div>'
        + '</div>'
        + '<span class="analysis-band-pct">' + b.pct + '%</span>'
        + '</div>'
      ).join('');

      const clipSection = clipEvts.length > 0
        ? '<div class="analysis-metric" style="border-left-color:#ff6b6b;">'
          + '<span class="analysis-label" style="color:#ff6b6b;">Clipping Events:</span>'
          + '<span class="analysis-value" style="color:#ff6b6b;">' + clipEvts.length + ' detected</span></div>'
          + '<div class="analysis-clipping-log">'
          + '<div class="analysis-clipping-header">Clipping Timestamps:</div>'
          + '<div class="analysis-clipping-events">'
          + clipEvts.map(tc => '<div class="analysis-clipping-event">' + tc + '</div>').join('')
          + '</div></div>'
        : '<div class="analysis-metric" style="border-left-color:#7ec98f;">'
          + '<span class="analysis-label" style="color:#7ec98f;">Clipping Events:</span>'
          + '<span class="analysis-value" style="color:#7ec98f;">None detected \u2713</span></div>';

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

      const gainStr    = Math.abs(gainToTgt) < 0.1 ? 'On target'
        : gainToTgt > 0 ? '+' + gainToTgt.toFixed(1) + ' dB needed'
        : gainToTgt.toFixed(1) + ' dB (will be reduced)';
      const inf        = '\u2212\u221e';
      const chLabel    = nCh === 1 ? 'Mono' : nCh === 2 ? 'Stereo' : nCh + '-channel';
      const dur        = buf.duration;

      upd(100, 'Complete!');
      await new Promise(r => setTimeout(r, 200));

      resultsEl.innerHTML = `
        <div class="analysis-track-name">${trackName}</div>

        <div class="analysis-section-header">LOUDNESS</div>
        <div class="analysis-metric">
          <span class="analysis-label">Integrated LUFS:</span>
          <span class="analysis-value">${intLUFS.toFixed(1)} LUFS</span>
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
          <span class="analysis-label">Loudness Range:</span>
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
          <span class="analysis-value">${truePeak.toFixed(1)} dBTP</span>
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
          <span class="analysis-label">Brightness:</span>
          <span class="analysis-value">${Math.round(spectralCentroid)} Hz <span class="analysis-tag good">${centroidLabel}</span></span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Dominant Freq:</span>
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
          <span class="analysis-value">${(buf.length / 1e6).toFixed(2)}M</span>
        </div>
        ${dcOffsetHTML}
      `;

    } catch (err) {
      resultsEl.innerHTML = '<div class="analysis-error">'
        + '<strong>Analysis Failed</strong><br>'
        + err.message + '<br>'
        + '<span style="font-size:0.85em;opacity:0.6">Ensure the track is loaded before analyzing.</span>'
        + '</div>';
    } finally {
      audioCtx.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Public: run(audioUrl, trackName, resultsEl)
  //   Call directly from a user-gesture handler (click, etc.).
  //   The AudioContext is created synchronously here, before any await.
  // ---------------------------------------------------------------------------
  function run(audioUrl, trackName, resultsEl) {
    // Must stay synchronous — AudioContext requires a user gesture activation window
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    resultsEl.innerHTML =
      '<div class="analysis-loading">'
      + '<span class="analysis-loading-text">Analyzing track</span>'
      + '<span class="analysis-loading-dots"><span>.</span><span>.</span><span>.</span></span>'
      + '<div class="analysis-loading-subtext">This may take a minute</div>'
      + '<div class="analysis-progress"><div class="analysis-progress-bar"></div></div>'
      + '<div class="analysis-progress-text">0%</div>'
      + '</div>';

    // Fire async analysis — AudioContext already locked in above
    _analyse(audioCtx, audioUrl, trackName, resultsEl);
  }

  return { run: run };

})();
