# ==============================================================================
# Script para Conexão de Instância / Exibição do QR Code (PowerShell)
# ==============================================================================

$RootPath = Split-Path -Parent $PSScriptRoot
Set-Location $RootPath

if (-not (Test-Path "$RootPath\.env")) {
    Write-Host "[ERRO] Arquivo .env não encontrado." -ForegroundColor Red
    exit 1
}

# Carrega variáveis do .env
$envContent = Get-Content "$RootPath\.env" | Where-Object { $_ -match '^\s*([^#=]+)=(.*)$' }
$envMap = @{}
foreach ($line in $envContent) {
    if ($line -match '^\s*([^#=]+)=(.*)$') {
        $envMap[$Matches[1].Trim()] = $Matches[2].Trim()
    }
}

$serverUrl = if ($envMap["SERVER_URL"]) { $envMap["SERVER_URL"] } else { "http://localhost:8080" }
$apiKey = $envMap["AUTHENTICATION_API_KEY"]
$instanceName = if ($envMap["INSTANCE_NAME"]) { $envMap["INSTANCE_NAME"] } else { "warnat-tech" }

$qrHtmlPath = "$RootPath\qr.html"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "         Conectando WhatsApp: $instanceName               " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "1. Abrindo a tela visual de pareamento..." -ForegroundColor Yellow
Write-Host "2. No celular: WhatsApp > Aparelhos Conectados > Conectar Aparelho" -ForegroundColor Yellow
Write-Host "3. Aponte a câmera para o QR Code.`n" -ForegroundColor Yellow

# Abre o visualizador autenticado local no navegador
try {
    Start-Process $qrHtmlPath
} catch {
    Write-Host "Abra o arquivo no navegador: $qrHtmlPath" -ForegroundColor Green
}
