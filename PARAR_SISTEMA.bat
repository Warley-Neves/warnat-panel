@echo off
chcp 65001 > nul
title WarNat Tech - Parar Sistema
color 0C

echo ====================================================================
echo             WARNAT TECH - PARANDO SERVICOS LOCAIS
echo ====================================================================
echo.

cd /d "D:\Projetos\evolution"

echo Parando containers Docker...
docker compose down

echo Parando servidor do painel (porta 3100)...
powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'panel' -or $_.Path -match 'node' } | Stop-Process -Force -ErrorAction SilentlyContinue"

echo.
echo [OK] Todos os servicos foram pausados com sucesso!
echo.
pause
