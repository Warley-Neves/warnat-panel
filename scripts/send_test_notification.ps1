# ==============================================================================
# Script de Teste de Notificação / Webhook (PowerShell)
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
$phone = if ($envMap["NOTIFICATION_PHONE"]) { $envMap["NOTIFICATION_PHONE"] } else { "5531999999999" }

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Enviando Notificação de Teste via Evolution API        " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Destinatário: $phone" -ForegroundColor Yellow

$testMessage = @"
🚨 *NOVO AGENDAMENTO DE VISITA - WARNAT TECH*

*Tipo:* Para minha empresa (TESTE)
*Problema:* Cabeamento estruturado e lentidão de rede
*Bairro:* Centro Empresarial
*Período:* Prefiro pela manhã
*Dados do Cliente:* João Silva - Av. Paulista, 1000 - Sala 402
"@

$body = @{
    number = $phone
    text = $testMessage
} | ConvertTo-Json

$headers = @{
    "apikey" = $apiKey
    "Content-Type" = "application/json"
}

try {
    $endpoint = "$serverUrl/message/sendText/$instanceName"
    $response = Invoke-RestMethod -Uri $endpoint -Method Post -Headers $headers -Body $body
    Write-Host "`n[✓] Mensagem de teste enviada com sucesso!" -ForegroundColor Green
    $response | ConvertTo-Json -Depth 5 | Write-Host
} catch {
    Write-Host "`n[ERRO] Falha ao enviar mensagem de teste: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host "Detalhe: $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
}
