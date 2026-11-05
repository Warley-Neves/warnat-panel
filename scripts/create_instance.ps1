# ==============================================================================
# Script de Criação de Instância (PowerShell)
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
$instanceToken = if ($envMap["INSTANCE_TOKEN"]) { $envMap["INSTANCE_TOKEN"] } else { "token-interno-warnat-123" }
$integration = if ($envMap["INTEGRATION"]) { $envMap["INTEGRATION"] } else { "WHATSAPP-BAILEYS" }

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "       Criando Instância: $instanceName na Evolution API   " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Endpoint: $serverUrl/instance/create" -ForegroundColor Gray

$body = @{
    instanceName = $instanceName
    token = $instanceToken
    qrcode = $true
    integration = $integration
} | ConvertTo-Json

$headers = @{
    "apikey" = $apiKey
    "Content-Type" = "application/json"
}

try {
    $response = Invoke-RestMethod -Uri "$serverUrl/instance/create" -Method Post -Headers $headers -Body $body
    Write-Host "`n[✓] Instância criada com sucesso!" -ForegroundColor Green
    $response | ConvertTo-Json -Depth 5 | Write-Host
    
    Write-Host "`n==========================================================" -ForegroundColor Yellow
    Write-Host "PRÓXIMO PASSO: CONECTAR O WHATSAPP" -ForegroundColor Yellow
    Write-Host "Acesse o navegador para ver o QR Code:" -ForegroundColor White
    Write-Host "$serverUrl/instance/connect/$instanceName" -ForegroundColor Cyan
    Write-Host "Ou execute o script: .\scripts\connect_instance.ps1" -ForegroundColor White
    Write-Host "==========================================================" -ForegroundColor Yellow
} catch {
    Write-Host "`n[ERRO] Falha ao criar instância: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host "Detalhe: $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
}
