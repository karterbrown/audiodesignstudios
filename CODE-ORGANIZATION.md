# Audio Design Studios - Code Organization

## Overview
This document explains the site structure and file organization to help you maintain and update the code.

## File Structure

### HTML Pages (3 Main Pages)
1. **index.html** - Home/Editorial page with integrated editorial content
2. **compose.html** - Compose portfolio page with Design & Compose sections (formerly music.html)
3. **matrix.html** - Easter egg Matrix animation page

### CSS Architecture

#### Shared Styles
- **shared.css** (1,030 lines)
  - Base styles, resets, typography
  - Header/navigation styles (.logo, .nav)
  - Common layout components
  - Responsive breakpoints (@media queries)
  - Imported by all page-specific CSS files

#### Page-Specific Styles
- **index.css** (~970 lines)
  - @import shared.css
  - Home page hero images (.env-home)
  - Ambient player section
  - Services grid
  - Home-specific layouts

- **editorial.css** (310 lines)
  - @import shared.css
  - Editorial hero image (.env-editorial)
  - Banner title styles (.banner-title)
  - Editorial sections (intro, values, services, etc.)
  - Used by index.html for editorial content styling

- **compose.css** (1,875 lines)
  - @import shared.css
  - Design/Compose hero images (.env-design, .env-portfolio)
  - Audio players and controls
  - VU meters
  - Portfolio layouts

- **matrix.css** (227 lines)
  - Matrix animation styles
  - Used by matrix.html

### JavaScript Files
- **content.js** - Minimal utilities (copyright year, lazy loading, debounce)
- **matrix-shared.js** - Reusable MatrixAnimation class with phase-based character cycling

### Deployment Scripts
- **deploy.sh** - Main deployment script (runs update-version.sh, commits, pushes to GitHub)
- **update-version.sh** - Updates cache-busting version numbers in all HTML files
- **check-deploy.sh** - Verifies deployment status by comparing local/GitHub/live versions
- **pull.sh** - Pulls latest changes from GitHub

## CSS Import Chain

```
index.html loads:
├── index.css
│   └── @import shared.css
└── editorial.css
    └── @import shared.css

compose.html loads:
├── compose.css
│   └── @import shared.css
└── matrix.css

matrix.html loads:
└── matrix.css
```

## Key CSS Classes

### Layout
- `.section` - Standard content section with padding
- `.section-alt` - Alternative section padding
- `.env-image` - Hero banner base styles
- `.env-home`, `.env-editorial`, `.env-design`, `.env-portfolio` - Page-specific hero images

### Typography
- `.logo` - Site header title (1.8rem on all screens)
- `.banner-title` - Hero banner text (defined in editorial.css and compose.css)

### Navigation
- `.site-header` - Fixed header
- `.nav` - Navigation links container
- `.special-link` - Compose link styling

## Responsive Breakpoints

### Defined in shared.css:
- **@media (max-width: 800px)** - Tablet adjustments
- **@media (max-width: 720px)** - Mobile phones
- **@media (min-width: 720px)** - Tablet+ (for images)
- **@media (min-width: 1200px)** - Desktop+ (for images)

### Logo Sizes:
- Desktop: 1.8rem
- Tablet (≤800px): 1.8rem  
- Mobile (≤720px): 1.8rem
- **Consistent across all breakpoints with !important**

### Banner Images:
- All banner images (.env-*) use 60vh min-height
- All maintain same background-size: cover and background-position: center
- Responsive images load at 720px and 1200px breakpoints

## Making Changes

### To update colors:
Look in **shared.css** for:
- Primary green: `#7ec98f`
- Dark background: `#0f0f0f`
- Light text: `#f4f4ff`

### To update header/logo:
Edit `.logo` in **shared.css** (line ~560)

### To update banner styling:
- For Editorial page: edit `.banner-title` in **editorial.css** (line ~38)
- For Design & Compose sections: edit `.banner-title` in **compose.css** (line ~68)

### To add a new page:
1. Create `newpage.html` + `newpage.css`
2. Add `@import url('./shared.css');` at top of CSS file
3. Add navigation link to all page headers
4. Update `update-version.sh` to include the new CSS file

## Cache-Busting System

All CSS files use version query parameters:
```html
<link rel="stylesheet" href="index.css?v=1771539651" />
```

**Always run `./deploy.sh` after making changes** - this:
1. Updates version numbers automatically
2. Commits changes to git
3. Pushes to GitHub

The version number is a Unix timestamp that forces browsers to reload updated files.

## Common Tasks

### Deploy changes:
```bash
./deploy.sh "Description of changes"
```

### Check if deployment is live:
```bash
./check-deploy.sh
```

### Pull latest changes:
```bash
./pull.sh
```

### Manual version update (if needed):
```bash
./update-version.sh
```

## Removed/Cleaned Up

The following items were removed during cleanup:
- ✅ `editorial.html.backup` - Unused backup file
- ✅ Duplicate `@media (max-width: 720px)` queries in shared.css
- ✅ Unnecessary `@media (600px, 480px, 375px)` queries
- ✅ Extra closing brace in shared.css
- ✅ Duplicate `.banner-title` definition in index.css
- ✅ References to old "music.html/css" filenames

## Current Status

The codebase is now:
- ✅ Organized with clear separation of concerns
- ✅ Free of duplicate CSS rules
- ✅ Properly named files reflecting actual content
- ✅ Easy to navigate and maintain
- ✅ Fully documented

Last updated: February 20, 2026
