#!/bin/bash

# Check if deployment is live
# Compares local version with live site version

echo "🔍 Checking deployment status..."
echo ""

# Get local version
LOCAL_VERSION=$(grep -o 'index\.css?v=[0-9]*' index.html | grep -o '[0-9]*')
echo "📁 Local version:  $LOCAL_VERSION"

# Get GitHub raw version
GITHUB_VERSION=$(curl -s "https://raw.githubusercontent.com/karterbrown/audiodesignstudios/main/index.html" | grep -o 'index\.css?v=[0-9]*' | grep -o '[0-9]*')
echo "📦 GitHub version: $GITHUB_VERSION"

# Get live site version
LIVE_VERSION=$(curl -s "https://www.audiodesignstudios.com/" | grep -o 'index\.css?v=[0-9]*' | grep -o '[0-9]*' || echo "styles.css (OLD)")
echo "🌐 Live version:   $LIVE_VERSION"

echo ""
if [ "$LOCAL_VERSION" = "$GITHUB_VERSION" ]; then
  echo "✅ GitHub repository is up to date"
else
  echo "❌ GitHub repository is NOT up to date - run ./deploy.sh"
fi

if [ "$GITHUB_VERSION" = "$LIVE_VERSION" ]; then
  echo "✅ Live site is up to date"
  echo ""
  echo "If you don't see changes, hard refresh: Cmd+Shift+R"
else
  echo "⏳ Live site is still deploying..."
  echo ""
  echo "GitHub Pages is rebuilding (takes 1-10 minutes)"
  echo "Check again in a few minutes!"
fi
