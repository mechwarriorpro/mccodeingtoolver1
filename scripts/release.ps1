# Builds the Windows installer. Run from the repo root: powershell -ExecutionPolicy Bypass -File scripts/release.ps1
$ErrorActionPreference = "Stop"
Write-Host "==> checking toolchain" -ForegroundColor Cyan
node --version
npm --version
try { java -version 2>&1 | Select-Object -First 1 } catch { Write-Warning "Java 21 not found on PATH (only needed to build mods, not to package the app)" }
try { gh --version | Select-Object -First 1 } catch { Write-Warning "GitHub CLI not found (needed for GitHub builds)" }

Write-Host "==> installing dependencies" -ForegroundColor Cyan
npm install

Write-Host "==> typecheck + tests" -ForegroundColor Cyan
npm run typecheck
npm test

Write-Host "==> packaging installer" -ForegroundColor Cyan
npm run dist:win

Get-ChildItem release\*.exe | ForEach-Object { Write-Host "built: $($_.FullName) ($([math]::Round($_.Length/1MB,1)) MB)" -ForegroundColor Green }
