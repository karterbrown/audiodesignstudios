#!/bin/bash

# Update Version Script
# Run this script whenever you make changes to CSS or JavaScript files
# to ensure browsers reload the files instead of using cached versions

# Generate new version number (current timestamp)
NEW_VERSION=$(date +%s)

echo "Updating cache-busting version to: $NEW_VERSION"

# Update all CSS file versions in HTML files
sed -i '' "s/index\.css?v=[0-9]*/index.css?v=$NEW_VERSION/g" *.html
sed -i '' "s/portfolio\.css?v=[0-9]*/portfolio.css?v=$NEW_VERSION/g" *.html
sed -i '' "s/about\.css?v=[0-9]*/about.css?v=$NEW_VERSION/g" *.html
sed -i '' "s/matrix\.css?v=[0-9]*/matrix.css?v=$NEW_VERSION/g" *.html
sed -i '' "s/shared\.css?v=[0-9]*/shared.css?v=$NEW_VERSION/g" *.html

# Update JavaScript file versions in HTML files
sed -i '' "s/content\.js?v=[0-9]*/content.js?v=$NEW_VERSION/g" *.html

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
