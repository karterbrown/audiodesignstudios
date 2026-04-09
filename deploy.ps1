# Quick Deploy Script (PowerShell)
# Updates cache-busting versions and pushes all changes to GitHub

$BashExe = "C:\Program Files\Git\bin\bash.exe"

Write-Host "Updating cache-busting versions..." -ForegroundColor Cyan
& $BashExe ./update-version.sh
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: update-version.sh failed." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Staging all changes..." -ForegroundColor Cyan
git add .

Write-Host ""
$CommitMsg = Read-Host "Commit message"

if ([string]::IsNullOrWhiteSpace($CommitMsg)) {
    Write-Host "ERROR: No commit message provided. Aborting." -ForegroundColor Red
    exit 1
}

git commit -m $CommitMsg
git push

Write-Host ""
Write-Host "Deployed! GitHub Pages will update in 1-10 minutes." -ForegroundColor Green
Write-Host "   Hard refresh: Ctrl+Shift+R"
