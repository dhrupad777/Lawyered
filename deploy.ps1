Write-Host "=== Deploying Lawyered ===" -ForegroundColor Cyan

if (-not $env:GOOGLE_API_KEY -or -not $env:COURTLISTENER_API_TOKEN) {
    Write-Host "ERROR: set `$env:GOOGLE_API_KEY and `$env:COURTLISTENER_API_TOKEN before running." -ForegroundColor Red
    exit 1
}

Write-Host "`n[1/2] Deploying backend..." -ForegroundColor Yellow
Set-Location "C:\Users\dhrup\Desktop\Google GenAi Academy\Lawyered\backend"

# Required vars + optional Elastic / model overrides (all optional => the
# backend degrades gracefully to CourtListener-only + the default model).
$backendEnv = "GOOGLE_API_KEY=$env:GOOGLE_API_KEY,COURTLISTENER_API_TOKEN=$env:COURTLISTENER_API_TOKEN"
if ($env:LAWYERED_MODEL)        { $backendEnv += ",LAWYERED_MODEL=$env:LAWYERED_MODEL" }
if ($env:ELASTIC_MCP_URL)       { $backendEnv += ",ELASTIC_MCP_URL=$env:ELASTIC_MCP_URL" }
if ($env:ELASTIC_API_KEY)       { $backendEnv += ",ELASTIC_API_KEY=$env:ELASTIC_API_KEY" }
if ($env:ELASTICSEARCH_URL)     { $backendEnv += ",ELASTICSEARCH_URL=$env:ELASTICSEARCH_URL" }
if ($env:LAWYERED_ELASTIC_LOCAL){ $backendEnv += ",LAWYERED_ELASTIC_LOCAL=$env:LAWYERED_ELASTIC_LOCAL" }

gcloud run deploy lawyered-backend --source . --region us-central1 --allow-unauthenticated --set-env-vars "$backendEnv"

if ($env:ELASTICSEARCH_URL) {
    Write-Host "Tip: seed + warm Elastic so the first demo query is fast:" -ForegroundColor DarkGray
    Write-Host "  python -m scripts.create_elastic_indices; python -m scripts.seed_elastic" -ForegroundColor DarkGray
    Write-Host "  python -c `"import elastic_client; print(elastic_client.warm_elser())`"" -ForegroundColor DarkGray
}

Write-Host "`n[2/2] Deploying frontend..." -ForegroundColor Yellow
Set-Location "C:\Users\dhrup\Desktop\Google GenAi Academy\Lawyered\frontend"
gcloud run deploy lawyered-frontend --source . --region us-central1 --allow-unauthenticated --set-env-vars "BACKEND_URL=https://lawyered-backend-201079023050.us-central1.run.app"

Write-Host "`n=== Deploy complete ===" -ForegroundColor Green
