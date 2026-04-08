Write-Host "=== Deploying Lawyered ===" -ForegroundColor Cyan

if (-not $env:GOOGLE_API_KEY -or -not $env:COURTLISTENER_API_TOKEN) {
    Write-Host "ERROR: set `$env:GOOGLE_API_KEY and `$env:COURTLISTENER_API_TOKEN before running." -ForegroundColor Red
    exit 1
}

Write-Host "`n[1/2] Deploying backend..." -ForegroundColor Yellow
Set-Location "C:\Users\dhrup\Desktop\Google GenAi Academy\Lawyered\backend"
gcloud run deploy lawyered-backend --source . --region us-central1 --allow-unauthenticated --set-env-vars "GOOGLE_API_KEY=$env:GOOGLE_API_KEY,COURTLISTENER_API_TOKEN=$env:COURTLISTENER_API_TOKEN"

Write-Host "`n[2/2] Deploying frontend..." -ForegroundColor Yellow
Set-Location "C:\Users\dhrup\Desktop\Google GenAi Academy\Lawyered\frontend"
gcloud run deploy lawyered-frontend --source . --region us-central1 --allow-unauthenticated --set-env-vars "BACKEND_URL=https://lawyered-backend-201079023050.us-central1.run.app"

Write-Host "`n=== Deploy complete ===" -ForegroundColor Green
