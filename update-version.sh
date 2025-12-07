#!/bin/bash

# Update Version Script
# Run this script whenever you make changes to styles.css or content.js
# to ensure browsers reload the files instead of using cached versions

# Generate new version number (current timestamp)
NEW_VERSION=$(date +%s)

echo "Updating cache-busting version to: $NEW_VERSION"

# Update all HTML files
sed -i '' "s/styles\.css?v=[0-9]*/styles.css?v=$NEW_VERSION/g" *.html
sed -i '' "s/content\.js?v=[0-9]*/content.js?v=$NEW_VERSION/g" *.html

echo "✓ Version updated in all HTML files"
echo ""
echo "Next steps:"
echo "1. Hard refresh your browser (Cmd+Shift+R on Mac)"
echo "2. Or clear browser cache and reload"
