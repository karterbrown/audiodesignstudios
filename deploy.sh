#!/bin/bash

# Quick Deploy Script
# Updates cache-busting versions and pushes all changes to GitHub

echo "🔄 Updating cache-busting versions..."
./update-version.sh

echo ""
echo "📦 Staging all changes..."
git add .

echo ""
read -rp "💬 Commit message: " COMMIT_MSG

if [[ -z "$COMMIT_MSG" ]]; then
  echo "❌ No commit message provided. Aborting."
  exit 1
fi

git commit -m "$COMMIT_MSG"
git push

echo ""
echo "✅ Deployed! GitHub Pages will update in 1–10 minutes."
echo "   Hard refresh: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)"
