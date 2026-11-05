# ==============================================================================
# Script de Diagnóstico e Status (PowerShell)
# ==============================================================================

$RootPath = Split-Path -Parent $PSScriptRoot
Set-Location $RootPath

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "            Status dos Containers Docker                  " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
docker compose ps

if (Test-Path "$RootPath\.env") {
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

    Write-Host "`n==========================================================" -ForegroundColor Cyan
    Write-Host "         Estado da Conexão da Instância: $instanceName    " -ForegroundColor Cyan
    Write-Host "==========================================================" -ForegroundColor Cyan

    $headers = @{
        "apikey" = $apiKey
    }

    try {
        $endpoint = "$serverUrl/instance/connectionState/$instanceName"
        $response = Invoke-RestMethod -Uri $endpoint -Method Get -Headers $headers -TimeoutSec 5
        Write-Host "Status da Conexão: " -NoNewline
        if ($response.instance.state -eq "open") {
            Write-Host "$($response.instance.state) (CONECTADO E OPERACIONAL)" -ForegroundColor Green
        } else {
            Write-Host "$($response.instance.state) (DESCONECTADO / AGUARDANDO QR CODE)" -ForegroundColor Yellow
        }
        $response | ConvertTo-Json -Depth 3 | Write-Host
    } catch {
        Write-Host "Instância ainda não conectada ou API indisponível." -ForegroundColor Red
        Write-Host "Detalhe: $($_.Exception.Message)" -ForegroundColor Gray
    }
}
