# Check Deployment Status (PowerShell)
# Compares local version with GitHub and live site versions

Write-Host "Checking deployment status..." -ForegroundColor Cyan
Write-Host ""

# Get local version from index.html
$LocalContent = Get-Content "index.html" -Raw
$LocalMatch = [regex]::Match($LocalContent, 'index\.css\?v=(\d+)')
$LocalVersion = if ($LocalMatch.Success) { $LocalMatch.Groups[1].Value } else { "NOT FOUND" }
Write-Host "Local version:  $LocalVersion"

# Get GitHub raw version
try {
    $GithubContent = (Invoke-WebRequest -Uri "https://raw.githubusercontent.com/karterbrown/audiodesignstudios/main/index.html" -UseBasicParsing -ErrorAction Stop).Content
    $GithubMatch = [regex]::Match($GithubContent, 'index\.css\?v=(\d+)')
    $GithubVersion = if ($GithubMatch.Success) { $GithubMatch.Groups[1].Value } else { "NOT FOUND" }
} catch {
    $GithubVersion = "ERROR (network)"
}
Write-Host "GitHub version: $GithubVersion"

# Get live site version
try {
    $LiveContent = (Invoke-WebRequest -Uri "https://www.audiodesignstudios.com/" -UseBasicParsing -ErrorAction Stop).Content
    $LiveMatch = [regex]::Match($LiveContent, 'index\.css\?v=(\d+)')
    $LiveVersion = if ($LiveMatch.Success) { $LiveMatch.Groups[1].Value } else { "NOT FOUND" }
} catch {
    $LiveVersion = "ERROR (network)"
}
Write-Host "Live version:   $LiveVersion"

Write-Host ""

if ($LocalVersion -eq $GithubVersion) {
    Write-Host "GitHub repository is up to date" -ForegroundColor Green
} else {
    Write-Host "GitHub repository is NOT up to date - run ./deploy.ps1" -ForegroundColor Red
}

if ($GithubVersion -eq $LiveVersion) {
    Write-Host "Live site is up to date" -ForegroundColor Green
    Write-Host ""
    Write-Host "If you don't see changes, hard refresh: Ctrl+Shift+R"
} else {
    Write-Host "Live site is still deploying..." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "GitHub Pages is rebuilding (takes 1-10 minutes)"
    Write-Host "Check again in a few minutes!"
}
