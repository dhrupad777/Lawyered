$ErrorActionPreference = "Stop"

Write-Host "=== Lawyered: deploy:manual ===" -ForegroundColor Cyan

$RepoRoot     = "C:\Users\dhrup\Desktop\Google GenAi Academy\Lawyered"
$FrontendDir  = Join-Path $RepoRoot "frontend"
$BackendDir   = Join-Path $RepoRoot "backend"
$Region       = "us-central1"
$BackendName  = "lawyered-backend"
$FrontendName = "lawyered-frontend"

# --- 1/4 Pre-flight build ---
Write-Host "`n[1/4] Building frontend locally (catch errors before deploy)..." -ForegroundColor Yellow
Set-Location $FrontendDir
if (Test-Path ".next") { Remove-Item -Recurse -Force ".next" }
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "Frontend build failed. Aborting." -ForegroundColor Red; exit 1 }

# --- 2/4 Backend ---
Write-Host "`n[2/4] Deploying backend to Cloud Run..." -ForegroundColor Yellow
if (-not $env:GOOGLE_API_KEY -or -not $env:COURTLISTENER_API_TOKEN) {
    Write-Host "ERROR: GOOGLE_API_KEY and COURTLISTENER_API_TOKEN must be set in your shell env before running this script." -ForegroundColor Red
    exit 1
}
Set-Location $BackendDir
gcloud run deploy $BackendName `
    --source . `
    --region $Region `
    --allow-unauthenticated `
    --set-env-vars "GOOGLE_API_KEY=$env:GOOGLE_API_KEY,COURTLISTENER_API_TOKEN=$env:COURTLISTENER_API_TOKEN"
if ($LASTEXITCODE -ne 0) { Write-Host "Backend deploy failed. Aborting." -ForegroundColor Red; exit 1 }

$BackendUrl = (gcloud run services describe $BackendName --region $Region --format "value(status.url)").Trim()
Write-Host "Backend URL: $BackendUrl" -ForegroundColor Green

# --- 3/4 Frontend ---
Write-Host "`n[3/4] Deploying frontend to Cloud Run..." -ForegroundColor Yellow
Set-Location $FrontendDir
gcloud run deploy $FrontendName `
    --source . `
    --region $Region `
    --allow-unauthenticated `
    --set-env-vars "BACKEND_URL=$BackendUrl"
if ($LASTEXITCODE -ne 0) { Write-Host "Frontend deploy failed. Aborting." -ForegroundColor Red; exit 1 }

# --- 4/4 Firestore rules ---
Write-Host "`n[4/4] Deploying Firestore rules..." -ForegroundColor Yellow
Set-Location $RepoRoot
firebase deploy --only firestore:rules
if ($LASTEXITCODE -ne 0) { Write-Host "Firestore rules deploy failed (continuing)." -ForegroundColor Red }

# --- Summary ---
$FrontendUrl = (gcloud run services describe $FrontendName --region $Region --format "value(status.url)").Trim()

Write-Host "`n=== Deploy complete ===" -ForegroundColor Green
Write-Host "Backend  : $BackendUrl" -ForegroundColor Cyan
Write-Host "Frontend : $FrontendUrl" -ForegroundColor Cyan
Write-Host "`nSubmit this Cloud Run URL: $FrontendUrl" -ForegroundColor Yellow
