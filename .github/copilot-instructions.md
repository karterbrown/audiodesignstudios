# Audio Design Studios - Copilot Instructions

## Project Overview
Static portfolio website for audio design services, deployed via GitHub Pages to `www.audiodesignstudios.com`. Features custom audio players, Matrix-style animations, and responsive design optimized for performance.

## Architecture

### Page Structure
- **2 main pages**: `index.html` (Design - Home with Editorial content), `compose.html` (Compose - Portfolio)
- **Easter egg**: `matrix.html` - Secret full-screen Matrix animation (accessed via logo click on home)
- Editorial content is now integrated into the home page with an `#editorial` anchor
- Each page follows pattern: HTML + page-specific CSS + imports `shared.css`

### CSS Architecture
All page-specific CSS files import `shared.css` first:
```css
@import url('./shared.css');
```
- `shared.css` (1105 lines) - All common styles, fonts, header, footer, utilities
- `editorial.css` (240 lines) - Editorial page-specific styles
- `index.css` (975 lines) - Home page grid and unique layouts
- `music.css` (combined Design + Compose, ~1400 lines) - Audio players, portfolios, VU meters
- `matrix.css` (227 lines) - Matrix animation styles

### JavaScript Organization
- `content.js` - Minimal utilities (copyright year, lazy loading, debounce)
- `matrix-shared.js` - Reusable MatrixAnimation class with phase-based character cycling
- Inline `<script>` tags for page-specific logic (audio players, matrix instances)

## Critical Patterns

### Cache-Busting System
**Always run `./update-version.sh` before deploying CSS/JS changes**. This updates timestamp versions in all HTML files:
```html
<link rel="stylesheet" href="index.css?v=1770072888" />
```
The `deploy.sh` script automatically calls this before git push.

### Deployment Workflow
1. Make changes to CSS/JS/HTML
2. Run `./deploy.sh` (auto-updates versions, commits, pushes)
3. Run `./check-deploy.sh` to verify live deployment status (GitHub Pages takes 1-10 min)

Never manually edit version numbers - the script uses Unix timestamps.

### Responsive Images
Use multi-resolution WebP pattern for hero images:
```css
.env-home {
  background-image: url('../Photos/homepiano800.webp');  /* Mobile */
}
@media (min-width: 720px) {
  .env-home { background-image: url('../Photos/homepiano1400.webp'); }
}
@media (min-width: 1200px) {
  .env-home { background-image: url('../Photos/homepiano2000.webp'); }
}
```

### Matrix Animation System
The `MatrixAnimation` class cycles through 5 character phases:
1. Binary (0, 1)
2. Math symbols (∴, ∵, ∞, ∑, etc.)
3. Japanese katakana
4. Musical notes (♩, ♪, ♫, ♬, etc.) - **8 seconds pure + 2 second transition**
5. Mixed (all sets randomly)

Each phase: 7 seconds, except musical (10s total). See `MATRIX_CONFIG` in `matrix-shared.js`.

### Navigation Pattern
Header navigation is consistent across all pages except `matrix.html`. The home page logo links to `matrix.html` as Easter egg; all other pages link to `index.html`.

## Development Conventions

### HTML Comments
Use section dividers extensively:
```html
<!-- ========================================================================
     SECTION NAME - Description
     ======================================================================== -->
```

### File Paths
- Photos relative to root: `Photos/filename.webp`
- Audio files in subdirectories: `allworks/`, `hiddentracks/`, `highlights/`, `daughteroftheplains/`
- CSS/JS at root level

### Performance Optimizations
- Preconnect to Google Fonts in `<head>`
- Aggressive cache control headers (no-cache, must-revalidate)
- `loading="lazy"` on images with IntersectionObserver fallback
- Canvas rendering with `{ alpha: false, desynchronized: true }`

## Testing Checklist
After changes:
1. Test locally (open HTML files directly)
2. Run `./deploy.sh` with descriptive commit message
3. Hard refresh browser: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)
4. Run `./check-deploy.sh` to verify versions match across local/GitHub/live
5. If changes don't appear: DevTools → Right-click reload → "Empty Cache and Hard Reload"

## Common Tasks

**Add new audio track to music page**: Add track to appropriate section (`#design` or `#compose`) in `music.html` with inline player controls

**Update Matrix character sets**: Modify `MATRIX_CONFIG` in `matrix-shared.js` - indexes must match `chars` string positions

**Change site colors**: Edit CSS custom properties in `shared.css` - look for color hex values like `#7ec98f` (green accent) and `#0f0f0f` (dark background)

**Add new page**: Create `newpage.html` + `newpage.css`, import `shared.css`, add nav link to headers on index.html and music.html
