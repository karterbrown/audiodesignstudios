# CSS Cleanup Guide

## index.css - Unused Code to Remove

### ❌ REMOVE ENTIRELY (Not used on index.html):

1. **Lines 219-249**: `.before-after-section` and `.ba-single-player` - These are for before/after audio players not on this page

2. **Lines 254-304**: `.matrix-row` and `@keyframes matrixFall` - Matrix animation is on matrix.html, not index.html

3. **Lines 729-850**: `.before-after-playlist-section`, `.playlist-card`, `.track-item` and all related styles - These playlist styles are not used on index page

4. **Lines 849-965**: All `.track-item-*` styles including progress bars, play buttons, scrubbers - These are for playlists not on index

### ✅ KEEP (Actually used):
- `.grid` - Used for card layouts
- `.env-image`, `.env-home`, `.env-about` - Hero backgrounds
- `blockquote` - Testimonials
- `.hero-highlights-3col` and related - 3-column layout
- `.album-cover-centered`, `.headshot-wrapper-portrait` - Images
- `.ambient-player-*` - All ambient player styles
- `.highlight-progress-*` - Used for highlight tracks (if present)
- All responsive `@media` queries

## Recommended Organization

Add these section headers to make navigation easier:

```css
/* =============================================================================
   TABLE OF CONTENTS
   -----------------------------------------------------------------------------
   1. GRID LAYOUTS - Basic grid system for cards
   2. HERO IMAGES & BANNERS - Home and About hero backgrounds
   3. EDITORIAL VALUES - 3-card value proposition section
   4. HIGHLIGHTS SECTION - 3-column layout with album covers
   5. AMBIENT MUSIC PLAYER - Horizontal music player
   6. RESPONSIVE DESIGN - Mobile and tablet adjustments
   ============================================================================= */
```

## editorial.css - Already Well Organized
✅ This file is cleanand minimal. No changes needed.

## compose.css - Add Table of Contents

This file is 1875 lines and needs better organization. Add this at the top after imports:

```css
/* =============================================================================
   TABLE OF CONTENTS
   -----------------------------------------------------------------------------
   1. HERO BANNER IMAGES - Design & Compose backgrounds
   2. AUDIO PLAYERS - Design player (cinematic sound design)
   3. BEFORE/AFTER TOGGLE - Analog processing comparison
   4. PORTFOLIO PLAYERS - Daughter of the Plains, All Works
   5. HIDDEN TRACKS SECTION - Special unlisted tracks
   6. VU METERS & CONTROLS - Visual audio meters
   7. PLAYLIST LAYOUTS -Track lists and items
   8. CONTACT FORM - Get in touch section
   9. RESPONSIVE DESIGN - Mobile and tablet adjustments
   ============================================================================= */
```

## shared.css - Add Section Markers

This is the most important file (1030 lines). Add clear section headers:

```css
/* =============================================================================
   1. RESET & BASE STYLES
   2. TYPOGRAPHY
   3. SITE HEADER & NAVIGATION
   4. COMMON SECTIONS & CONTAINERS
   5. BUTTONS & FORMS
   6. FOOTER
   7. UTILITIES
   8. RESPONSIVE BREAKPOINTS
   ============================================================================= */
```

## Estimated Savings

- **index.css**: Current 968 lines → After cleanup ~650 lines (save ~320 lines)
- **compose.css**: Needs better section organization only
- **shared.css**: Add section headers for navigation

## Action Items

1. **IMMEDIATE**: Remove unused code from index.css (lines listed above)
2. **ORGANIZATION**: Add table of contents to all 3 main CSS files
3. **SECTION MARKERS**: Add clear `/* === SECTION NAME === */` dividers
4. **TESTING**: Verify site still works after cleanup with `./check-deploy.sh`
