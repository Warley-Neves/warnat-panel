# ==============================================================================
# Iniciar Painel Multi-Tenant WhatsApp & Operações (PowerShell)
# ==============================================================================

$RootPath = Split-Path -Parent $PSScriptRoot
Set-Location $RootPath

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Iniciando Painel Multi-Tenant WhatsApp (Warnat Tech)    " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$serverScript = "$RootPath\panel\server.js"
if (-not (Test-Path $serverScript)) {
    Write-Host "[ERRO] Arquivo panel/server.js não encontrado!" -ForegroundColor Red
    exit 1
}

Start-Process -FilePath "node" -ArgumentList "`"$serverScript`"" -WindowStyle Hidden
Start-Sleep -Seconds 2

Write-Host "`n[V] Painel iniciado com sucesso!" -ForegroundColor Green
Write-Host "Abra no seu navegador: http://localhost:3100" -ForegroundColor Cyan
Write-Host "Gerencie todas as operações e leia QR Codes em um único lugar!" -ForegroundColor Green
