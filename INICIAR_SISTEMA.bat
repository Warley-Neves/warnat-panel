@echo off
chcp 65001 > nul
title WarNat Tech - Inicializador do Sistema Completo
color 0A

echo ====================================================================
echo           WARNAT TECH - INICIALIZADOR DO SISTEMA COMPLETO
echo ====================================================================
echo.

cd /d "D:\Projetos\evolution"

echo [1/4] Verificando Docker Desktop...
docker info >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [!] Docker Desktop nao esta ativo. Iniciando Docker Desktop...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    echo Aguardando o Docker inicializar (isso pode levar cerca de 30 a 50 segundos)...
    :WAIT_DOCKER
    timeout /t 5 /nobreak >nul
    docker info >nul 2>&1
    if %ERRORLEVEL% NEQ 0 (
        echo Ainda aguardando o Docker Engine ficar pronto...
        goto WAIT_DOCKER
    )
)
echo [OK] Docker Engine conectado com sucesso!

echo.
echo [2/4] Subindo containers da Evolution API, PostgreSQL e Chatwoot...
docker compose up -d

echo.
echo [3/4] Iniciando o Painel de Controle Multi-Tenant (Porta 3100)...
powershell -Command "$p = Get-NetTCPConnection -LocalPort 3100 -ErrorAction SilentlyContinue; if (-not $p) { Start-Process -FilePath 'node' -ArgumentList 'panel/server.js' -WindowStyle Hidden; Write-Host 'Painel iniciado na porta 3100' } else { Write-Host 'Painel ja esta rodando na porta 3100' }"

echo.
echo ====================================================================
echo                    SISTEMA ATIVO E PRONTO!
echo ====================================================================
echo - Evolution API (WhatsApp): http://localhost:8085
echo - Conectar QR Code:         http://localhost:8085/instance/connect/warnat-tech
echo - Chatwoot (Atendimento):   http://localhost:3000
echo - Painel Gerencial:         http://localhost:3100
echo - Cerebro IA (Typebot):     https://app.typebot.io
echo ====================================================================
echo.
pause
