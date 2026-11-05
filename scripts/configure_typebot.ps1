# ==============================================================================
# Script de Vinculação Evolution API <-> Typebot (PowerShell)
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
$typebotUrl = if ($envMap["TYPEBOT_URL"]) { $envMap["TYPEBOT_URL"] } else { "https://viewer.typebot.io" }
$typebotName = if ($envMap["TYPEBOT_NAME"]) { $envMap["TYPEBOT_NAME"] } else { "warnat-atendimento-xyz" }
$expire = if ($envMap["TYPEBOT_EXPIRE"]) { [int]$envMap["TYPEBOT_EXPIRE"] } else { 20 }
$keywordFinish = if ($envMap["TYPEBOT_KEYWORD_FINISH"]) { $envMap["TYPEBOT_KEYWORD_FINISH"] } else { "#parar" }
$delayMessage = if ($envMap["TYPEBOT_DELAY_MESSAGE"]) { [int]$envMap["TYPEBOT_DELAY_MESSAGE"] } else { 1500 }
$debounceTime = if ($envMap["TYPEBOT_DEBOUNCE_TIME"]) { [int]$envMap["TYPEBOT_DEBOUNCE_TIME"] } else { 10 }
$unknownMsg = if ($envMap["TYPEBOT_UNKNOWN_MESSAGE"]) { $envMap["TYPEBOT_UNKNOWN_MESSAGE"] } else { "Desculpe, não compreendi. Poderia repetir?" }

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "     Vinculando Typebot à Instância: $instanceName        " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Typebot URL: $typebotUrl" -ForegroundColor Gray
Write-Host "Typebot Slug/Nome: $typebotName" -ForegroundColor Gray

$body = @{
    enabled = $true
    url = $typebotUrl
    typebot = $typebotName
    triggerType = "all"
    expire = $expire
    keywordFinish = $keywordFinish
    delayMessage = $delayMessage
    unknownMessage = $unknownMsg
    listeningFromMe = $false
    stopBotFromMe = $true
    keepOpen = $false
    debounceTime = $debounceTime
} | ConvertTo-Json

$headers = @{
    "apikey" = $apiKey
    "Content-Type" = "application/json"
}

try {
    $endpoint = "$serverUrl/typebot/create/$instanceName"
    $response = Invoke-RestMethod -Uri $endpoint -Method Post -Headers $headers -Body $body
    Write-Host "`n[✓] Typebot vinculado e ativado com sucesso!" -ForegroundColor Green
    $response | ConvertTo-Json -Depth 5 | Write-Host
} catch {
    Write-Host "`n[ERRO] Falha ao configurar Typebot: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host "Detalhe: $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
}
