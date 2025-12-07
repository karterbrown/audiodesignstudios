#!/bin/bash

# Quick Deploy Script
# Updates cache-busting versions and pushes all changes to GitHub

echo "🔄 Updating cache-busting versions..."
./update-version.sh

echo ""
echo "📦 Staging all changes..."
git add .

echo ""
echo "💬 Enter commit message:"
read -r COMMIT_MESSAGE

if [ -z "$COMMIT_MESSAGE" ]; then
  echo "❌ Commit message cannot be empty"
  exit 1
fi

echo ""
echo "✅ Committing changes..."
git commit -m "$COMMIT_MESSAGE"

echo ""
echo "🚀 Pushing to GitHub..."
git push

echo ""
echo "✨ Done! Your changes are live."
