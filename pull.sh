#!/bin/bash

# Git Pull Script
# Safely pulls the latest changes from GitHub

echo "🔄 Pulling latest changes from GitHub..."
echo ""

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
  echo "⚠️  You have uncommitted changes:"
  git status --short
  echo ""
  echo "Options:"
  echo "1) Stash changes and pull (recommended)"
  echo "2) Abort pull"
  read -p "Enter your choice (1 or 2): " choice
  
  if [ "$choice" = "1" ]; then
    echo "📦 Stashing changes..."
    git stash
  else
    echo "❌ Pull cancelled"
    exit 1
  fi
fi

# Pull from GitHub
echo "📥 Pulling from GitHub..."
git pull

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ Successfully pulled latest changes!"
  echo ""
  echo "📊 Status:"
  git log --oneline -5
  echo ""
  echo "Ready to deploy? Run: ./deploy.sh"
else
  echo ""
  echo "❌ Pull failed. Check your connection and try again."
  exit 1
fi
