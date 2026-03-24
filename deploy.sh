#!/bin/bash

# Quick Deploy Script
# Updates cache-busting versions and pushes all changes to GitHub

echo "🔄 Updating cache-busting versions..."
./update-version.sh

echo ""
echo "📦 Staging all changes..."
git add .

echo ""
echo "✅ All changes staged. Ready to commit and push when you are."
echo "   git commit -m \"your message\""
echo "   git push"
