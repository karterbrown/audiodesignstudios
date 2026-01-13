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

# Update JavaScript file versions in HTML files
sed -i '' "s/content\.js?v=[0-9]*/content.js?v=$NEW_VERSION/g" *.html

echo "✓ Version updated in all HTML files"
echo ""
echo "Next steps:"
echo "1. Hard refresh your browser (Cmd+Shift+R on Mac)"
echo "2. Or clear browser cache and reload"
