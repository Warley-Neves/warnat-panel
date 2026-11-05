# ==============================================================================
# Script de Parada dos Serviços (PowerShell)
# ==============================================================================

$RootPath = Split-Path -Parent $PSScriptRoot
Set-Location $RootPath

Write-Host "Parando containers da Evolution API..." -ForegroundColor Yellow
docker compose down

Write-Host "[✓] Containers finalizados com segurança." -ForegroundColor Green
