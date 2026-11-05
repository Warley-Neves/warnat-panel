# ==============================================================================
# Script de Inicialização dos Serviços (PowerShell)
# ==============================================================================

$RootPath = Split-Path -Parent $PSScriptRoot
Set-Location $RootPath

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "    Iniciando Evolution API v2 & PostgreSQL (Warnat Tech)  " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# Verifica se o arquivo .env existe
if (-not (Test-Path "$RootPath\.env")) {
    Write-Host "[!] Arquivo .env não encontrado. Copiando de .env.example..." -ForegroundColor Yellow
    Copy-Item "$RootPath\.env.example" "$RootPath\.env"
    Write-Host "[✓] Arquivo .env criado com sucesso." -ForegroundColor Green
}

# Carrega variáveis do .env para conferência da porta
$envContent = Get-Content "$RootPath\.env" | Where-Object { $_ -match '^\s*([^#=]+)=(.*)$' }
$envMap = @{}
foreach ($line in $envContent) {
    if ($line -match '^\s*([^#=]+)=(.*)$') {
        $envMap[$Matches[1].Trim()] = $Matches[2].Trim()
    }
}

$port = if ($envMap["EVOLUTION_PORT"]) { $envMap["EVOLUTION_PORT"] } else { "8080" }

# Checa se a porta está ocupada
$portBusy = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
if ($portBusy) {
    Write-Host "[AVISO] A porta $port já possui processos escutando no host." -ForegroundColor Yellow
    Write-Host "Se o Docker reportar conflito de porta, altere EVOLUTION_PORT no arquivo .env (ex: 8085)." -ForegroundColor Yellow
}

Write-Host "`nSubindo containers via Docker Compose..." -ForegroundColor Cyan
docker compose up -d

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n[✓] Containers iniciados com sucesso!" -ForegroundColor Green
    docker compose ps
    Write-Host "`nAguarde cerca de 10 a 15 segundos para o banco de dados inicializar." -ForegroundColor Gray
    Write-Host "URL da Evolution API: http://localhost:$port" -ForegroundColor Cyan
    Write-Host "URL do Chatwoot CRM: http://localhost:3000" -ForegroundColor Cyan

    # Inicia o Painel Multi-Tenant se não estiver rodando
    $panelBusy = Get-NetTCPConnection -LocalPort 3100 -ErrorAction SilentlyContinue
    if (-not $panelBusy) {
        Start-Process -FilePath "node" -ArgumentList "`"$RootPath\panel\server.js`"" -WindowStyle Hidden
        Write-Host "URL do Painel Multi-Tenant: http://localhost:3100" -ForegroundColor Green
    }
} else {
    Write-Host "`n[ERRO] Falha ao iniciar containers. Verifique os logs com: docker compose logs" -ForegroundColor Red
}
