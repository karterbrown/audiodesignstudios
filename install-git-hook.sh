#!/bin/bash

# Install Git Hook Script
# Run this once after cloning the repository to set up automatic version updates

echo "Installing Git post-commit hook..."

# Copy the hook to .git/hooks/
cp hooks/post-commit .git/hooks/post-commit

# Make it executable
chmod +x .git/hooks/post-commit

echo "✓ Git hook installed successfully!"
echo ""
echo "The hook will automatically update cache-busting versions after each commit."
