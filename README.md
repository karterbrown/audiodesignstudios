# Audio Design Studios Website

Portfolio website for Karter G. Brown - Audio Design Studios

## Setup

After cloning this repository, run the installation script to set up automatic cache-busting:

```bash
./install-git-hook.sh
```

This installs a Git hook that automatically updates version numbers for CSS and JS files after each commit, ensuring browsers always load the latest version.

## Development Workflow

```bash
# Make your changes to HTML, CSS, or JS files

# Commit changes (hook automatically updates versions)
git add .
git commit -m "your message"

# Push to GitHub
git push
```

The cache-busting versions will be updated automatically with each commit!

## Manual Version Update

If you need to manually update versions without committing:

```bash
./update-version.sh
```

## Contact

Email: music@kartergbrown.com
