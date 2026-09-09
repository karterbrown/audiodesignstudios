/* =============================================================================
   analyzer.js — Audio analysis engine — Audio Design Studios
   Offline track analysis: ITU-R BS.1770-4 integrated LUFS, True Peak (4x
   Catmull-Rom), EBU Tech 3342 LRA, BPM (onset-strength
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
  // Container probe — reads the real file header.
  // decodeAudioData resamples to the AudioContext rate, so the decoded buffer
  // can NOT be trusted for sample rate / bit depth / channel count.
  // ---------------------------------------------------------------------------
  function probeContainer(ab) {
    const v = new DataView(ab);
    const u8 = new Uint8Array(ab);
    const n  = u8.length;
    const tag = (o, s) => {
      for (let i = 0; i < s.length; i++) if (u8[o + i] !== s.charCodeAt(i)) return false;
      return true;
    };
    const find = (s, from, to) => {
      const end = Math.min(to, n - s.length);
      for (let i = from; i <= end; i++) if (tag(i, s)) return i;
      return -1;
    };
    const out = { format: null, sampleRate: 0, channels: 0, bitDepth: 0, lossless: false, codec: null };
    if (n < 32) return out;

    try {
      // ── RIFF / WAVE ──────────────────────────────────────────────────────
      if (tag(0, 'RIFF') && tag(8, 'WAVE')) {
        out.format = 'WAV'; out.lossless = true;
        let p = 12;
        while (p + 8 <= n) {
          const id = String.fromCharCode(u8[p], u8[p+1], u8[p+2], u8[p+3]);
          const sz = v.getUint32(p + 4, true);
          if (id === 'fmt ') {
            let fmtCode = v.getUint16(p + 8, true);
            out.channels   = v.getUint16(p + 10, true);
            out.sampleRate = v.getUint32(p + 12, true);
            out.bitDepth   = v.getUint16(p + 22, true);
            if (fmtCode === 0xFFFE && sz >= 40) fmtCode = v.getUint16(p + 32, true);
            out.codec = fmtCode === 3 ? 'PCM float' : fmtCode === 1 ? 'PCM' : 'code ' + fmtCode;
            break;
          }
          p += 8 + sz + (sz & 1);
        }
        return out;
      }

      // ── AIFF / AIFC ──────────────────────────────────────────────────────
      if (tag(0, 'FORM') && (tag(8, 'AIFF') || tag(8, 'AIFC'))) {
        out.format = tag(8, 'AIFC') ? 'AIFC' : 'AIFF';
        out.lossless = true;
        let p = 12;
        while (p + 8 <= n) {
          const id = String.fromCharCode(u8[p], u8[p+1], u8[p+2], u8[p+3]);
          const sz = v.getUint32(p + 4, false);
          if (id === 'COMM') {
            out.channels = v.getUint16(p + 8, false);
            out.bitDepth = v.getUint16(p + 14, false);
            // 80-bit IEEE 754 extended float
            const o  = p + 16;
            const e  = ((u8[o] << 8) | u8[o + 1]) & 0x7fff;
            const hi = v.getUint32(o + 2, false), lo = v.getUint32(o + 6, false);
            out.sampleRate = Math.round(
              hi * Math.pow(2, e - 16383 - 31) + lo * Math.pow(2, e - 16383 - 63)
            );
            out.codec = out.format === 'AIFC' && sz >= 22
              ? String.fromCharCode(u8[p+26], u8[p+27], u8[p+28], u8[p+29]) : 'PCM';
            break;
          }
          p += 8 + sz + (sz & 1);
        }
        return out;
      }

      // ── FLAC ─────────────────────────────────────────────────────────────
      if (tag(0, 'fLaC')) {
        out.format = 'FLAC'; out.lossless = true; out.codec = 'FLAC';
        const o = 18; // STREAMINFO + 10 bytes of block sizes
        out.sampleRate = (u8[o] << 12) | (u8[o+1] << 4) | (u8[o+2] >> 4);
        out.channels   = ((u8[o+2] >> 1) & 0x07) + 1;
        out.bitDepth   = (((u8[o+2] & 1) << 4) | (u8[o+3] >> 4)) + 1;
        return out;
      }

      // ── Ogg (Vorbis / Opus / FLAC) ───────────────────────────────────────
      if (tag(0, 'OggS')) {
        out.format = 'OGG';
        const vo = find('vorbis', 0, 4096);
        const op = find('OpusHead', 0, 4096);
        if (op >= 0) {
          out.codec = 'Opus';
          out.channels = u8[op + 9];
          out.sampleRate = 48000; // Opus always decodes at 48 kHz
        } else if (vo >= 0) {
          // 'vorbis' sits one byte into the identification packet:
          // 0x01 'vorbis' version(4) channels(1) rate(4)
          out.codec = 'Vorbis';
          out.channels   = u8[vo + 10];
          out.sampleRate = v.getUint32(vo + 11, true);
        }
        return out;
      }

      // ── MP4 / M4A ────────────────────────────────────────────────────────
      if (tag(4, 'ftyp')) {
        out.format = 'MP4';
        const mp4a = find('mp4a', 0, Math.min(n, 4 << 20));
        const alac = find('alac', 0, Math.min(n, 4 << 20));
        out.codec = alac >= 0 ? 'ALAC' : mp4a >= 0 ? 'AAC' : null;
        out.lossless = alac >= 0;
        const box = alac >= 0 ? alac : mp4a;
        if (box >= 0) {
          out.channels   = v.getUint16(box + 4 + 16, false);
          out.sampleRate = v.getUint32(box + 4 + 24, false) >>> 16;
        }
        // mdhd timescale is authoritative for rates above 65535
        const mdhd = find('mdhd', 0, Math.min(n, 4 << 20));
        if (mdhd >= 0) {
          const ver = u8[mdhd + 4];
          const ts  = ver === 1 ? v.getUint32(mdhd + 8 + 16, false) : v.getUint32(mdhd + 8 + 8, false);
          if (ts >= 8000 && ts <= 768000) out.sampleRate = ts;
        }
        return out;
      }

      // ── MP3 ──────────────────────────────────────────────────────────────
      let off = 0;
      if (tag(0, 'ID3')) {
        off = 10 + ((u8[6] & 0x7f) << 21 | (u8[7] & 0x7f) << 14 | (u8[8] & 0x7f) << 7 | (u8[9] & 0x7f));
      }
      for (let i = off; i < Math.min(n - 4, off + 200000); i++) {
        if (u8[i] !== 0xff || (u8[i + 1] & 0xe0) !== 0xe0) continue;
        const verBits = (u8[i + 1] >> 3) & 3;         // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
        const layer   = (u8[i + 1] >> 1) & 3;         // 1=Layer III
        const brIdx   = (u8[i + 2] >> 4) & 0x0f;
        const srIdx   = (u8[i + 2] >> 2) & 3;
        if (verBits === 1 || layer === 0 || srIdx === 3 || brIdx === 0 || brIdx === 15) continue;
        const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
        out.format = 'MP3';
        out.codec  = 'MPEG' + (verBits === 3 ? '1' : verBits === 2 ? '2' : '2.5')
                   + ' Layer ' + (layer === 3 ? 'I' : layer === 2 ? 'II' : 'III');
        out.sampleRate = SR[verBits][srIdx];
        out.channels   = ((u8[i + 3] >> 6) & 3) === 3 ? 1 : 2;
        return out;
      }
    } catch (e) { /* unknown or malformed container — fall back to decoded values */ }

    return out;
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
      const fileBytes = arrayBuf.byteLength;

      // ── Probe the real container header ────────────────────────────────────
      const meta = probeContainer(arrayBuf);

      // ── Decode ─────────────────────────────────────────────────────────────
      // Decode inside an OfflineAudioContext running at the file's native rate
      // so the samples are not silently resampled to the output device rate.
      upd(15, 'Decoding audio\u2026');
      let buf = null, decodedAtNative = false;
      if (meta.sampleRate >= 8000 && meta.sampleRate <= 192000) {
        try {
          const oc = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
            1, 1, meta.sampleRate
          );
          buf = await oc.decodeAudioData(arrayBuf.slice(0));
          decodedAtNative = true;
        } catch (e) { buf = null; }
      }
      if (!buf) buf = await audioCtx.decodeAudioData(arrayBuf);
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

      // ── Mean square per 100 ms tile ────────────────────────────────────────
      // Tiles do not overlap, so any window that is a whole number of tiles has
      // an exact mean square. Momentary (400 ms) and short-term (3 s) windows
      // are then just sums of 4 and 30 tiles.
      const subLen = Math.max(1, Math.round(sr * 0.1));
      const nSub   = Math.floor(nSmp / subLen);
      if (nSub < 4)
        throw new Error('Track is too short for loudness analysis (minimum 400 ms).');

      upd(25, 'Processing loudness blocks\u2026');
      const subMS = new Float64Array(nSub); // channel-weighted mean square per tile
      for (let ch = 0; ch < nCh; ch++) {
        const w = G_WEIGHT[ch];
        if (w === 0.0) continue;
        const kw = kwChs[ch];
        for (let s = 0; s < nSub; s++) {
          let sq = 0;
          for (let i = s * subLen, end = i + subLen; i < end; i++) sq += kw[i] * kw[i];
          subMS[s] += w * (sq / subLen);
        }
        upd(25 + ((ch + 1) / nCh) * 45, 'Channel ' + (ch + 1) + ' / ' + nCh + '\u2026');
        await new Promise(r => setTimeout(r, 0));
      }

      // 400 ms momentary blocks on a 100 ms grid (ITU-R BS.1770-4 §2.2)
      const nBlocks = nSub - 3;
      const blockMS = new Float64Array(nBlocks);
      const blockL  = new Float64Array(nBlocks);
      for (let bi = 0; bi < nBlocks; bi++) {
        const ms = (subMS[bi] + subMS[bi + 1] + subMS[bi + 2] + subMS[bi + 3]) * 0.25;
        blockMS[bi] = ms;
        blockL[bi]  = ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity;
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
        // both gates apply; the relative gate can fall below -70 on very quiet material
        if (blockL[i] >= relGate && blockL[i] >= -70) { fMs += blockMS[i]; fN++; }
      }
      const intLUFS = fN > 0 ? -0.691 + 10 * Math.log10(fMs / fN) : -100;

      // Max Momentary LUFS — loudest 400 ms window, ungated (EBU Tech 3341)
      let maxMomentary = -100;
      for (let i = 0; i < nBlocks; i++) if (blockL[i] > maxMomentary) maxMomentary = blockL[i];

      // Short-term — 3 s windows on a 100 ms grid (30 tiles), ungated max
      const ST_WIN = 30;
      const stL  = [];
      const stMS = [];
      let maxShortTerm = -100;
      if (nSub >= ST_WIN) {
        let run = 0;
        for (let k = 0; k < ST_WIN; k++) run += subMS[k];
        for (let si = 0; ; si++) {
          const ms = run / ST_WIN;
          const l  = ms > 0 ? -0.691 + 10 * Math.log10(ms) : -100;
          stL.push(l); stMS.push(ms);
          if (l > maxShortTerm) maxShortTerm = l;
          if (si + ST_WIN >= nSub) break;
          run += subMS[si + ST_WIN] - subMS[si];
        }
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
      let truePeak = -100, samplePeakLin = 0;
      for (let ch = 0; ch < nCh; ch++) {
        const d = chs[ch];
        const n = d.length;
        for (let i = 1; i < n - 2; i++) {
          const y1 = d[i];
          const pa = y1 < 0 ? -y1 : y1;
          if (pa > samplePeakLin) samplePeakLin = pa;
          if (pa > 0) {
            const db = 20 * Math.log10(pa);
            if (db > truePeak) truePeak = db;
          }
          // 4x Catmull-Rom upsampling at t = 0.25, 0.5, 0.75.
          // Threshold is well below full scale because an inter-sample peak can
          // sit a couple of dB above the highest actual sample.
          if (pa > 0.25) {
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
      const monoMix = new Float32Array(nSmp);
      let sqL = 0, sqR = 0, sumL = 0, sumR = 0, sumLR = 0, sqM = 0, sqS = 0;
      for (let i = 0; i < nSmp; i++) {
        const l = chL[i], r = chR[i];
        sqL += l*l; sqR += r*r;
        sumL += l;  sumR += r;
        sumLR += l*r;
        const M = (l + r) * 0.5, S = (l - r) * 0.5;
        monoMix[i] = M;
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
      const samplePeak = samplePeakLin > 1e-9 ? 20 * Math.log10(samplePeakLin) : -100;
      const overshoot  = truePeak - samplePeak;
      const crestFactor = rmsDb < -99 ? 0 : samplePeak - rmsDb;

      // ── Clipping detection — runs of consecutive samples pinned at full scale
      // A single sample at full scale is normal; three or more in a row is a
      // flat top, which is what clipping actually looks like.
      upd(84, 'Detecting clipping\u2026');
      const clipEvts = [];
      const clipStep = Math.floor(sr * 0.1);
      const CLIP_LEVEL = 0.9995, CLIP_RUN = 3;
      for (let pos = 0; pos + clipStep <= nSmp; pos += clipStep) {
        let clipped = false;
        for (let ch = 0; ch < nCh && !clipped; ch++) {
          const d = chs[ch];
          let run = 0;
          for (let i = pos, end = pos + clipStep; i < end; i++) {
            const a = d[i] < 0 ? -d[i] : d[i];
            if (a >= CLIP_LEVEL) {
              if (++run >= CLIP_RUN) { clipped = true; break; }
            } else run = 0;
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
      const specSrc = monoMix;
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
        const bpmSrc   = monoMix;
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

      const dur     = buf.duration;

      // File info — prefer the container header over the decoded buffer, since
      // decoding can resample and (for mono files) is always float32 internally.
      const srReported = meta.sampleRate || sr;
      const chReported = meta.channels   || buf.numberOfChannels;
      const chReportedLabel = chReported === 1 ? 'Mono' : chReported === 2 ? 'Stereo' : chReported + '-channel';
      const srStr = srReported % 1000 === 0
        ? (srReported / 1000) + ' kHz'
        : (srReported / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + ' kHz';
      const srNote = decodedAtNative || srReported === sr
        ? '' : ' <span class="analysis-tag info">analysed at ' + (sr / 1000).toFixed(1) + ' kHz</span>';
      const fmtStr = meta.format
        ? meta.format + (meta.codec && meta.codec !== meta.format ? ' \u00b7 ' + meta.codec : '')
        : 'Unknown container';
      const bitDepthStr = meta.bitDepth ? meta.bitDepth + '-bit' : (meta.lossless ? 'Unknown' : 'n/a (lossy)');
      const dataRate = dur > 0 ? (fileBytes * 8) / dur / 1000 : 0;
      const sizeStr = fileBytes >= 1048576
        ? (fileBytes / 1048576).toFixed(2) + ' MB'
        : (fileBytes / 1024).toFixed(1) + ' KB';

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
          <span class="analysis-label">Sample Peak:</span>
          <span class="analysis-value">${samplePeak > -99 ? samplePeak.toFixed(1) + ' dBFS' : inf + ' dBFS'}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">True Peak:</span>
          <span class="analysis-value">${truePeak > -99 ? truePeak.toFixed(1) + ' dBTP' : inf + ' dBTP'}${overshoot > 0.05 && truePeak > -99 ? ' <span class="analysis-tag info">+' + overshoot.toFixed(1) + ' dB inter-sample</span>' : ''}</span>
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

        <div class="analysis-section-header">FILE INFO</div>
        <div class="analysis-metric">
          <span class="analysis-label">Format:</span>
          <span class="analysis-value">${fmtStr}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Duration:</span>
          <span class="analysis-value">${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}.${String(Math.floor((dur % 1) * 100)).padStart(2, '0')}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Sample Rate:</span>
          <span class="analysis-value">${srStr}${srNote}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Bit Depth:</span>
          <span class="analysis-value">${bitDepthStr}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Channels:</span>
          <span class="analysis-value">${chReportedLabel}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">File Size:</span>
          <span class="analysis-value">${sizeStr}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Data Rate:</span>
          <span class="analysis-value">${dataRate > 0 ? Math.round(dataRate) + ' kbps' : '\u2014'}</span>
        </div>
        <div class="analysis-metric">
          <span class="analysis-label">Total Samples:</span>
          <span class="analysis-value">${(buf.length / 1e6).toFixed(2)} M per channel</span>
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

  // ---------------------------------------------------------------------------
  // Shared decode helper — decodes at an explicit rate so two files can be
  // compared sample-for-sample. Falls back to the default rate if the browser
  // refuses the requested one.
  // ---------------------------------------------------------------------------
  async function decodeAt(url, rate) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Fetch failed: ' + resp.status);
    const ab = await resp.arrayBuffer();
    const meta = probeContainer(ab);
    const want = rate || meta.sampleRate;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (want >= 8000 && want <= 192000) {
      try {
        return { buf: await new OAC(1, 1, want).decodeAudioData(ab.slice(0)), meta: meta };
      } catch (e) { /* fall through */ }
    }
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    try {
      return { buf: await ac.decodeAudioData(ab), meta: meta };
    } finally { ac.close(); }
  }

  function monoOf(buf) {
    const n = buf.length;
    const out = new Float32Array(n);
    const c = buf.numberOfChannels;
    if (c === 1) { out.set(buf.getChannelData(0)); return out; }
    const l = buf.getChannelData(0), r = buf.getChannelData(1);
    for (let i = 0; i < n; i++) out[i] = (l[i] + r[i]) * 0.5;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Integrated loudness + true peak only — used for streaming-level preview.
  // ---------------------------------------------------------------------------
  async function measureLoudness(url) {
    const { buf } = await decodeAt(url, 0);
    const sr = buf.sampleRate;
    const nCh = Math.min(buf.numberOfChannels, 6);
    const G = [1.0, 1.0, 1.0, 1.41, 1.41, 0.0];

    // True peak (4x Catmull-Rom around loud samples)
    let truePeak = -100;
    for (let ch = 0; ch < nCh; ch++) {
      const d = buf.getChannelData(ch), n = d.length;
      for (let i = 1; i < n - 2; i++) {
        const y1 = d[i], pa = y1 < 0 ? -y1 : y1;
        if (pa > 0) { const v = 20 * Math.log10(pa); if (v > truePeak) truePeak = v; }
        if (pa > 0.4) {
          const y0 = d[i - 1], y2 = d[i + 1], y3 = d[i + 2 < n ? i + 2 : n - 1];
          const c1 = (-y0 + y2) * 0.5;
          const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
          const c3 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
          for (let t = 0.25; t < 1; t += 0.25) {
            const v = ((c3 * t + c2) * t + c1) * t + y1;
            const av = v < 0 ? -v : v;
            if (av > pa) { const d2 = 20 * Math.log10(av); if (d2 > truePeak) truePeak = d2; }
          }
        }
      }
      await new Promise(r => setTimeout(r, 0));
    }

    const kw = [];
    for (let ch = 0; ch < nCh; ch++) {
      kw.push(kWeightFull(buf.getChannelData(ch), sr));
      await new Promise(r => setTimeout(r, 0));
    }

    const blockSz = Math.floor(sr * 0.4), stepSz = Math.floor(blockSz * 0.25);
    const nBlocks = Math.floor((buf.length - blockSz) / stepSz);
    if (nBlocks < 1) throw new Error('Track is too short to measure loudness.');
    const ms = new Float64Array(nBlocks), l = new Float64Array(nBlocks);
    for (let bi = 0; bi < nBlocks; bi++) {
      const pos = bi * stepSz;
      let m = 0;
      for (let ch = 0; ch < nCh; ch++) {
        if (G[ch] === 0) continue;
        const k = kw[ch];
        let sq = 0;
        for (let i = pos, e = pos + blockSz; i < e; i++) sq += k[i] * k[i];
        m += G[ch] * (sq / blockSz);
      }
      ms[bi] = m;
      l[bi] = m > 0 ? -0.691 + 10 * Math.log10(m) : -Infinity;
      if (bi % 400 === 0) await new Promise(r => setTimeout(r, 0));
    }

    let gMs = 0, gN = 0;
    for (let i = 0; i < nBlocks; i++) if (l[i] >= -70) { gMs += ms[i]; gN++; }
    if (gN === 0) throw new Error('Track is silent.');
    const relGate = -0.691 + 10 * Math.log10(gMs / gN) - 10;
    let fMs = 0, fN = 0;
    for (let i = 0; i < nBlocks; i++) if (l[i] >= relGate && l[i] >= -70) { fMs += ms[i]; fN++; }

    return {
      lufs: fN > 0 ? -0.691 + 10 * Math.log10(fMs / fN) : -100,
      truePeak: truePeak,
      duration: buf.duration,
      sampleRate: sr
    };
  }

  // ---------------------------------------------------------------------------
  // Difference spectrogram — B minus A, in dB, over log frequency and time.
  // Red = energy added by the processing, blue = energy removed.
  // ---------------------------------------------------------------------------
  async function renderDiff(urlA, urlB, canvas, onStatus) {
    const say = onStatus || function () {};
    const FFT_N = 2048, HALF = FFT_N >> 1;

    say('Decoding A\u2026');
    const a = await decodeAt(urlA, 0);
    const sr = a.buf.sampleRate;
    say('Decoding B\u2026');
    const b = await decodeAt(urlB, sr);

    const mA = monoOf(a.buf), mB = monoOf(b.buf);

    // ── Coarse time alignment via energy-envelope cross-correlation ─────────
    say('Aligning\u2026');
    const EH = 1024;
    const envOf = (d) => {
      const n = Math.floor(d.length / EH);
      const e = new Float32Array(n);
      for (let f = 0; f < n; f++) {
        let s = 0;
        for (let i = 0, o = f * EH; i < EH; i++) { const v = d[o + i]; s += v * v; }
        e[f] = Math.sqrt(s / EH);
      }
      return e;
    };
    const eA = envOf(mA), eB = envOf(mB);
    const maxLag = Math.min(Math.floor(sr * 1.5 / EH), Math.min(eA.length, eB.length) - 1);
    let bestLag = 0, bestScore = -Infinity;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let s = 0, c = 0;
      const from = Math.max(0, -lag), to = Math.min(eA.length, eB.length - lag);
      for (let i = from; i < to; i += 2) { s += eA[i] * eB[i + lag]; c++; }
      if (c > 0) { const sc = s / c; if (sc > bestScore) { bestScore = sc; bestLag = lag; } }
    }
    const shift = bestLag * EH; // samples to add to A's index to reach B
    const startA = Math.max(0, -shift), startB = Math.max(0, shift);
    const span = Math.min(mA.length - startA, mB.length - startB);
    if (span < FFT_N * 4) throw new Error('Files do not overlap enough to compare.');

    // ── Geometry ───────────────────────────────────────────────────────────
    const FONT = 11;
    const ML = 52, MR = 82, MT = 30, MB = 36;
    const W = canvas.width, H = canvas.height;
    const cW = W - ML - MR, cH = H - MT - MB;
    const hop = Math.max(512, Math.floor((span - FFT_N) / cW));
    const nCols = Math.max(1, Math.min(cW, Math.floor((span - FFT_N) / hop)));

    // Log-spaced frequency rows
    const F_LO = 30, F_HI = Math.min(20000, sr / 2);
    const rows = cH;
    const rowLo = new Int32Array(rows), rowHi = new Int32Array(rows);
    for (let r = 0; r < rows; r++) {
      // row 0 = top = highest frequency
      const t0 = (rows - 1 - r) / rows, t1 = (rows - r) / rows;
      const f0 = F_LO * Math.pow(F_HI / F_LO, t0);
      const f1 = F_LO * Math.pow(F_HI / F_LO, t1);
      let lo = Math.floor(f0 * FFT_N / sr), hi = Math.ceil(f1 * FFT_N / sr);
      if (hi <= lo) hi = lo + 1;
      rowLo[r] = Math.max(1, Math.min(HALF - 1, lo));
      rowHi[r] = Math.max(rowLo[r] + 1, Math.min(HALF, hi));
    }

    const win = new Float32Array(FFT_N);
    for (let i = 0; i < FFT_N; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_N - 1)));
    const reA = new Float32Array(FFT_N), imA = new Float32Array(FFT_N);
    const reB = new Float32Array(FFT_N), imB = new Float32Array(FFT_N);

    const ctx2 = canvas.getContext('2d');
    ctx2.fillStyle = '#0a0a0a';
    ctx2.fillRect(0, 0, W, H);
    const img = ctx2.createImageData(nCols, rows);
    const px = img.data;

    const RANGE = 12;      // dB mapped to full colour saturation
    const FLOOR = -96;     // band energy below this is treated as silence
    const STAT_FLOOR = -70; // only audible cells count toward the summary numbers
    let maxAdd = 0, maxCut = 0, sumAbs = 0, cells = 0;

    for (let c = 0; c < nCols; c++) {
      const oA = startA + c * hop, oB = startB + c * hop;
      for (let i = 0; i < FFT_N; i++) {
        reA[i] = mA[oA + i] * win[i]; imA[i] = 0;
        reB[i] = mB[oB + i] * win[i]; imB[i] = 0;
      }
      computeFFT(reA, imA);
      computeFFT(reB, imB);

      for (let r = 0; r < rows; r++) {
        let pa = 0, pb = 0;
        for (let k = rowLo[r]; k < rowHi[r]; k++) {
          pa += reA[k] * reA[k] + imA[k] * imA[k];
          pb += reB[k] * reB[k] + imB[k] * imB[k];
        }
        const nb = rowHi[r] - rowLo[r];
        const dA = pa > 0 ? 10 * Math.log10(pa / nb) - 60 : -200;
        const dB_ = pb > 0 ? 10 * Math.log10(pb / nb) - 60 : -200;

        let rr, gg, bb;
        if (dA < FLOOR && dB_ < FLOOR) {
          rr = 12; gg = 13; bb = 15;                       // both silent
        } else {
          const diff = Math.max(-40, Math.min(40, dB_ - dA));
          if (dA > STAT_FLOOR || dB_ > STAT_FLOOR) {
            if (diff > maxAdd) maxAdd = diff;
            else if (-diff > maxCut) maxCut = -diff;
            sumAbs += diff < 0 ? -diff : diff; cells++;
          }

          const t = Math.max(-1, Math.min(1, diff / RANGE));
          const mag = Math.pow(t < 0 ? -t : t, 0.65);
          if (t >= 0) {                                    // added energy
            rr = 18 + mag * 237; gg = 20 + mag * 70; bb = 24 + mag * 36;
          } else {                                         // removed energy
            rr = 18 + mag * 26;  gg = 20 + mag * 150; bb = 24 + mag * 231;
          }
        }
        const o = (r * nCols + c) * 4;
        px[o] = rr; px[o + 1] = gg; px[o + 2] = bb; px[o + 3] = 255;
      }

      if ((c & 31) === 0) {
        say('Comparing \u2014 ' + Math.round(c / nCols * 100) + '%');
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // ── Blit + axes ────────────────────────────────────────────────────────
    const tmp = document.createElement('canvas');
    tmp.width = nCols; tmp.height = rows;
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx2.imageSmoothingEnabled = false;
    ctx2.drawImage(tmp, ML, MT, cW, cH);

    ctx2.strokeStyle = 'rgba(208,208,208,0.35)';
    ctx2.lineWidth = 1;
    ctx2.strokeRect(ML + 0.5, MT + 0.5, cW - 1, cH - 1);

    ctx2.font = FONT + 'px "Courier New", monospace';
    ctx2.fillStyle = 'rgba(208,208,208,0.75)';
    ctx2.textAlign = 'right';
    ctx2.textBaseline = 'middle';
    [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].forEach(f => {
      if (f < F_LO || f > F_HI) return;
      const t = Math.log(f / F_LO) / Math.log(F_HI / F_LO);
      const y = Math.max(MT + FONT / 2, Math.min(MT + cH - FONT / 2, MT + cH - t * cH));
      ctx2.fillStyle = 'rgba(208,208,208,0.75)';
      ctx2.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), ML - 7, y);
      ctx2.strokeStyle = 'rgba(208,208,208,0.10)';
      ctx2.beginPath(); ctx2.moveTo(ML, y + 0.5); ctx2.lineTo(ML + cW, y + 0.5); ctx2.stroke();
    });

    const totalSec = nCols * hop / sr;
    ctx2.textBaseline = 'top';
    ctx2.textAlign = 'center';
    for (let i = 0; i <= 6; i++) {
      const s = totalSec * i / 6;
      const label = Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
      const half = ctx2.measureText(label).width / 2;
      // clamp so the first and last stamps stay inside the canvas
      const x = Math.max(half + 2, Math.min(W - half - 2, ML + (cW * i / 6)));
      ctx2.fillStyle = 'rgba(208,208,208,0.75)';
      ctx2.fillText(label, x, MT + cH + 7);
    }

    // Legend
    const lx = ML + cW + 14, lw = 12, lh = cH;
    const grad = ctx2.createLinearGradient(0, MT, 0, MT + lh);
    grad.addColorStop(0.00, 'rgb(255,90,60)');
    grad.addColorStop(0.50, 'rgb(18,20,24)');
    grad.addColorStop(1.00, 'rgb(44,170,255)');
    ctx2.fillStyle = grad;
    ctx2.fillRect(lx, MT, lw, lh);
    ctx2.strokeStyle = 'rgba(208,208,208,0.35)';
    ctx2.strokeRect(lx + 0.5, MT + 0.5, lw - 1, lh - 1);
    ctx2.fillStyle = 'rgba(208,208,208,0.8)';
    ctx2.textAlign = 'left';
    ctx2.textBaseline = 'middle';
    ctx2.fillText('+' + RANGE + ' dB',      lx + lw + 5, MT + FONT / 2);
    ctx2.fillText('0',                      lx + lw + 5, MT + lh / 2);
    ctx2.fillText('\u2212' + RANGE + ' dB', lx + lw + 5, MT + lh - FONT / 2);

    ctx2.textAlign = 'left';
    ctx2.textBaseline = 'top';
    ctx2.fillStyle = 'rgba(208,208,208,0.6)';
    ctx2.fillText('B \u2212 A', ML, 10);
    ctx2.textAlign = 'right';
    ctx2.fillText('Hz', ML - 7, 10);

    return {
      offsetMs: shift / sr * 1000,
      maxAdd: maxAdd,
      maxCut: maxCut,
      avgChange: cells > 0 ? sumAbs / cells : 0,
      seconds: totalSec,
      sampleRate: sr
    };
  }

  return { run: run, measureLoudness: measureLoudness, renderDiff: renderDiff };

})();
