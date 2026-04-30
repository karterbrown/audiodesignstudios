// ============================================================================
// SITE CONFIGURATION
// Minimal JS - only essential dynamic content and optimizations
// ============================================================================

// Update copyright year automatically
function updateCopyrightYear() {
  const yearSpan = document.querySelector('#year');
  if (yearSpan) yearSpan.textContent = new Date().getFullYear();
}

// Lazy load images for better performance
function initLazyLoading() {
  const images = document.querySelectorAll('img[loading="lazy"]');
  
  if ('IntersectionObserver' in window) {
    const imageObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.src) {
            img.src = img.dataset.src;
            img.removeAttribute('data-src');
          }
          img.classList.add('loaded');
          observer.unobserve(img);
        }
      });
    }, {
      rootMargin: '50px'
    });

    images.forEach(img => imageObserver.observe(img));
  }
}

// Debounce utility for resize events
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// =============================================================================
// GLASS DISTORTION ENGINE
//
// Combines kube.io/blog/liquid-glass-css-svg/ (structural approach) with
// the exact physics from @hashintel/refractive (displacement-map.ts):
//
//   1. GLSL-style refract() — full vector refraction (not Snell's tan approx):
//        eta = 1/n,  k = 1 − eta²(1−dot²),  refracted = [−(eta·dot+√k)·nX,
//                                                          eta−(eta·dot+√k)·nY]
//
//   2. RemainingHeight depth term — ray travels through the glass slab before
//        exiting, accumulating lateral offset:
//        displacement = refracted.x × (y·BEZEL + GLASS_THICKNESS) / refracted.y
//        where y = bezelHeight(t) is the local glass height at position t.
//
//   3. Circular-arc surface profile f(t) = sqrt(2t − t²) — smooth curved
//        bezel, maximum slope at t=0 (outer rim), zero slope at t=1 (flat
//        center). Numerical derivative avoids the t=0 singularity.
//
//   4. devicePixelRatio scaling — canvases are generated at physical pixels
//        (dpr × CSS pixels) for crisp rendering on HiDPI/Retina displays.
//        SVG filter coordinates remain in CSS pixels.
//
//   5. Two-layer output — feDisplacementMap (refraction) + feBlend(screen,
//        specularMap) — same pipeline as both source articles.
//
// Encoding: R = 128 + dX×127,  G = 128 + dY×127  (neutral = 128,128)
// Browser support: Chrome 76+ for backdrop-filter+SVG; others fall back.
// =============================================================================
function initGlassDistortion() {

  const BEZEL           = 22;    // bezel ring width in CSS px — matches mask 44px cutout
  const GLASS_THICKNESS = 200;   // virtual glass slab depth (arbitrary units)
  const REFRACTIVE_IDX  = 1.5;   // glass refractive index (air = 1.0)
  const SAMPLES         = 128;   // pre-computed profile steps
  const MAX_DISP        = Math.round(BEZEL * 1.2);  // max CSS px shift for feDisplacementMap

  const dpr = Math.min(window.devicePixelRatio || 1, 2);  // cap at 2× for perf

  // ── Circular-arc surface profile ──────────────────────────────────────────
  // f(t) = sqrt(2t − t²): height of glass surface from 0 (rim) to 1 (center).
  // t=0 → outer edge (tangent point, slope→∞), t=1 → flat center (slope=0).
  function bezelHeight(t) {
    return Math.sqrt(Math.max(0, 2 * t - t * t));
  }

  // ── GLSL refract() — @hashintel/refractive displacement-map.ts ────────────
  // Incident ray is [0, 1] (straight down through air).
  // Normal points inward(-x) and downward(-y): [-deriv/mag, -1/mag].
  // Returns refracted ray [rX, rY] or null on total internal reflection.
  function refract(normalX, normalY) {
    const eta = 1 / REFRACTIVE_IDX;
    const dot = normalY;                          // dot([0,1], normal) = normalY
    const k   = 1 - eta * eta * (1 - dot * dot);
    if (k < 0) return null;                       // TIR (doesn't occur for n=1.5)
    const sq  = Math.sqrt(k);
    return [
      -(eta * dot + sq) * normalX,                // lateral component
       eta - (eta * dot + sq) * normalY,          // axial component (always > 0)
    ];
  }

  // ── Pre-compute 1D refraction profile ────────────────────────────────────
  // rawProfile[i] = lateral displacement when glass height = bezelHeight(t).
  // Depth term: ray still travels (y·BEZEL + GLASS_THICKNESS) vertically
  // after refraction, accumulating (refracted.x / refracted.y) × height offset.
  const rawProfile = new Float32Array(SAMPLES);
  let maxRaw = 0;

  for (let i = 0; i < SAMPLES; i++) {
    const t  = i / SAMPLES;
    const y  = bezelHeight(t);

    // Numerical derivative (forward/backward at the boundary — avoids t=0 singularity)
    const dt   = t < 1 ? 0.0001 : -0.0001;
    const deriv = (bezelHeight(t + dt) - y) / dt;

    const mag     = Math.sqrt(deriv * deriv + 1);
    const refracted = refract(-deriv / mag, -1 / mag);
    if (!refracted || refracted[1] <= 0) continue;

    // Remaining vertical travel inside the glass slab
    const remainingH   = y * BEZEL + GLASS_THICKNESS;
    rawProfile[i] = refracted[0] * (remainingH / refracted[1]);
    if (rawProfile[i] > maxRaw) maxRaw = rawProfile[i];
  }

  // Normalise to [0, 1] — shape only; magnitude is MAX_DISP on feDisplacementMap
  const profile = new Float32Array(SAMPLES);
  if (maxRaw > 0) {
    for (let i = 0; i < SAMPLES; i++) profile[i] = rawProfile[i] / maxRaw;
  }

  function lookupProfile(cssPixelDist) {
    // Clamp to bezel width, convert to profile index
    const t   = Math.min(1, cssPixelDist / BEZEL);
    const idx = Math.min(SAMPLES - 1, Math.round(t * SAMPLES));
    return profile[idx] || 0;
  }

  // ── Displacement map ──────────────────────────────────────────────────────
  // Canvas at physical pixels (dpr×CSS) for HiDPI sharpness.
  // Encodes per-pixel background-shift direction + magnitude.
  // Neutral fill (128,128) = no shift; rendered over the full canvas first so
  // interior pixels (beyond bezel) are automatically neutral.
  function buildDisplacementMap(W, H) {
    const PW = Math.round(W * dpr), PH = Math.round(H * dpr);
    const bezelPx = BEZEL * dpr;

    const canvas = document.createElement('canvas');
    canvas.width = PW; canvas.height = PH;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(PW, PH);

    // Pre-fill neutral (128, 128, 0, 255)
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = img.data[i + 1] = 128;
      img.data[i + 2] = 0;
      img.data[i + 3] = 255;
    }

    for (let py = 0; py < PH; py++) {
      for (let px = 0; px < PW; px++) {
        const dL = px, dR = PW - 1 - px, dT = py, dB = PH - 1 - py;
        const m  = Math.min(dL, dR, dT, dB);
        if (m >= bezelPx) continue;  // interior — already neutral

        // Profile lookup in CSS px (dpr-unaware)
        const d = lookupProfile(m / dpr);

        // Displacement direction: inward from nearest edge
        //   feDisplacementMap: new_x = old_x + scale×(R/255 − 0.5)
        //   R > 128 → sample from the right  (left-edge pixels look into interior)
        //   R < 128 → sample from the left   (right-edge pixels look into interior)
        let dX = 0, dY = 0;
        if      (m === dL) dX =  d;   // left edge  → shift right (inward)
        else if (m === dR) dX = -d;   // right edge → shift left
        else if (m === dT) dY =  d;   // top edge   → shift down
        else               dY = -d;   // bottom edge → shift up

        const off = (py * PW + px) * 4;
        img.data[off]     = Math.max(0, Math.min(255, Math.round(128 + dX * 127)));
        img.data[off + 1] = Math.max(0, Math.min(255, Math.round(128 + dY * 127)));
        // off+2 (B) stays 0 — unused by feDisplacementMap
      }
    }

    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
  }

  // ── Specular highlight map ────────────────────────────────────────────────
  // Thin bright band inside the bezel — screen-blended over the refracted
  // backdrop. Peaks ~4px from the outer edge, tapers to 0 at the inner edge.
  // Teal-tinted to match site accent #00c8d4. HiDPI-scaled like the disp map.
  function buildSpecularMap(W, H) {
    const PW = Math.round(W * dpr), PH = Math.round(H * dpr);
    const bezelPx = BEZEL * dpr;
    const peakPx  = 4 * dpr;  // peak highlight distance from outer edge

    const canvas = document.createElement('canvas');
    canvas.width = PW; canvas.height = PH;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(PW, PH);

    // 45° light — uniform across all four sides (abs-dot = 0.707 on each edge)
    const LX = 0.707, LY = -0.707;

    for (let py = 0; py < PH; py++) {
      for (let px = 0; px < PW; px++) {
        const off = (py * PW + px) * 4;
        const dL  = px, dR = PW - 1 - px, dT = py, dB = PH - 1 - py;
        const m   = Math.min(dL, dR, dT, dB);

        if (m >= bezelPx) { img.data[off + 3] = 0; continue; }

        // Inward-facing surface normal direction for this edge
        let nX = 0, nY = 0;
        if      (m === dL) nX =  1;
        else if (m === dR) nX = -1;
        else if (m === dT) nY =  1;
        else               nY = -1;

        // Tent shape: ramp up to peak, ramp down to inner edge
        const t     = m / peakPx;
        const shape = t < 1 ? t : Math.max(0, 1 - (t - 1) / (bezelPx / peakPx - 1));

        const dot   = Math.abs(nX * LX + nY * LY);
        const coeff = dot * shape;
        const b     = Math.round(coeff * 220);

        img.data[off]     = 0;                                    // R
        img.data[off + 1] = Math.min(255, Math.round(b * 0.78)); // G — teal #00c8d4
        img.data[off + 2] = Math.min(255, Math.round(b * 0.83)); // B
        img.data[off + 3] = Math.min(255, b);                    // A
      }
    }

    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
  }

  // ── Build / update SVG filter ─────────────────────────────────────────────
  // Filter and feImage coordinates are in CSS pixels (filterUnits=userSpaceOnUse).
  // The browser scales canvas data URIs (physical pixels) to fit the CSS rect.
  // feDisplacementMap scale = MAX_DISP: max lateral shift in CSS px when dX=±1.
  let svgEl = null;

  function buildFilter(W, H) {
    const dispUri = buildDisplacementMap(W, H);
    const specUri = buildSpecularMap(W, H);

    if (!svgEl) {
      svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svgEl.setAttribute('aria-hidden', 'true');
      svgEl.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
      document.body.insertBefore(svgEl, document.body.firstChild);
    }

    svgEl.innerHTML = `
      <defs>
        <filter id="glass-distortion"
                x="0%" y="0%" width="100%" height="100%"
                color-interpolation-filters="sRGB">
          <feImage href="${dispUri}" x="0" y="0" width="${W}" height="${H}"
                   preserveAspectRatio="none" result="dispMap"/>
          <feDisplacementMap in="SourceGraphic" in2="dispMap"
                             scale="${MAX_DISP}"
                             xChannelSelector="R" yChannelSelector="G"/>
        </filter>
      </defs>`;
  }

  // ── Measure header and build ──────────────────────────────────────────────
  function update() {
    const header = document.querySelector('.site-header');
    if (!header) { console.warn('[glass] .site-header not found'); return; }
    const rect = header.getBoundingClientRect();
    const W = Math.round(rect.width);
    const H = Math.round(rect.height);
    console.log(`[glass] building filter ${W}×${H} (dpr=${dpr})`);
    if (W > 0 && H > 0) {
      buildFilter(W, H);
      const bd = getComputedStyle(header).backdropFilter || getComputedStyle(header).webkitBackdropFilter;
      console.log('[glass] computed backdrop-filter:', bd);
      console.log('[glass] SVG filter injected:', !!document.getElementById('glass-distortion'));
    }
  }

  update();

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(update, 150);
  }, { passive: true });
}

// Run on page load
function init() {
  updateCopyrightYear();
  initLazyLoading();
  initGlassDistortion();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { passive: true });
} else {
  init();
}

// Export utilities for use in other scripts
window.siteUtils = {
  debounce
};
