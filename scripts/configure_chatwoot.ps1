# ==============================================================================
# Script de Vinculação Evolution API <-> Chatwoot (PowerShell)
# ==============================================================================

param(
    [Parameter(Mandatory=$false)]
    [string]$ChatwootToken = ""
)

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

$serverUrl = if ($envMap["SERVER_URL"]) { $envMap["SERVER_URL"] } else { "http://localhost:8085" }
$apiKey = $envMap["AUTHENTICATION_API_KEY"]
$instanceName = if ($envMap["INSTANCE_NAME"]) { $envMap["INSTANCE_NAME"] } else { "warnat-tech" }

if (-not $ChatwootToken) {
    $ChatwootToken = Read-Host "Digite o seu Access Token do Chatwoot (pegue em Perfil > Access Token)"
}

if (-not $ChatwootToken) {
    Write-Host "[ERRO] Token do Chatwoot não fornecido." -ForegroundColor Red
    exit 1
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "    Conectando Evolution API ao Chatwoot (Warnat Tech)    " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$body = @{
    enabled = $true
    accountId = "1"
    token = $ChatwootToken
    url = "http://chatwoot-web:3000"
    signMsg = $false
    reopenConversation = $true
    conversationPending = $false
    nameInbox = "Warnat Tech WhatsApp"
    autoCreate = $true
    importContacts = $true
    importMessages = $true
    daysLimitImportMessages = 7
} | ConvertTo-Json

$headers = @{
    "apikey" = $apiKey
    "Content-Type" = "application/json"
}

try {
    $endpoint = "$serverUrl/chatwoot/set/$instanceName"
    $response = Invoke-RestMethod -Uri $endpoint -Method Post -Headers $headers -Body $body
    Write-Host "`n[✓] Chatwoot conectado com sucesso à instância $instanceName!" -ForegroundColor Green
    $response | ConvertTo-Json -Depth 5 | Write-Host
    Write-Host "`nAbra o Chatwoot no seu navegador: http://localhost:3000" -ForegroundColor Cyan
    Write-Host "A caixa de entrada 'Warnat Tech WhatsApp' já está ativa com todas as mensagens!" -ForegroundColor Green
} catch {
    Write-Host "`n[ERRO] Falha ao configurar Chatwoot: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host "Detalhe: $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
}
