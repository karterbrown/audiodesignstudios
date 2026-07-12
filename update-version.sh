#!/bin/bash

# Update Version Script
# Run this script whenever you make changes to CSS or JavaScript files
# to ensure browsers reload the files instead of using cached versions

# Generate new version number (current timestamp)
NEW_VERSION=$(date +%s)

echo "Updating cache-busting version to: $NEW_VERSION"

# Detect sed variant: GNU sed (Linux/Git-Bash) uses -i with no argument;
# BSD sed (macOS) requires -i '' with an empty-string argument.
if sed --version >/dev/null 2>&1; then
  # GNU sed
  SED() { sed -i "$@"; }
else
  # BSD sed (macOS)
  SED() { sed -i '' "$@"; }
fi

# Update all CSS file versions in HTML files
SED "s/index\.css?v=[0-9]*/index.css?v=$NEW_VERSION/g" *.html
SED "s/editorial\.css?v=[0-9]*/editorial.css?v=$NEW_VERSION/g" *.html
SED "s/compose\.css?v=[0-9]*/compose.css?v=$NEW_VERSION/g" compose/index.html
SED "s/matrix\.css?v=[0-9]*/matrix.css?v=$NEW_VERSION/g" compose/index.html matrix/index.html
SED "s/processor\.css?v=[0-9]*/processor.css?v=$NEW_VERSION/g" processor/index.html

# Update JavaScript file versions in HTML files
SED "s/content\.js?v=[0-9]*/content.js?v=$NEW_VERSION/g" *.html compose/index.html
SED "s/compose-players\.js?v=[0-9]*/compose-players.js?v=$NEW_VERSION/g" compose/index.html

echo "✓ Version updated in all HTML files"
echo "✓ New version: $NEW_VERSION"
echo ""
echo "After deploying, hard refresh your browser:"
echo "  Mac:     Cmd + Shift + R"
echo "  Windows: Ctrl + Shift + R"
echo ""
echo "If changes still don't appear:"
echo "  1. Open DevTools (F12)"
echo "  2. Right-click the refresh button"
echo "  3. Select 'Empty Cache and Hard Reload'"
