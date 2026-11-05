#!/bin/bash
# ==============================================================================
# Script de Inicialização dos Serviços (Linux / VPS Bash)
# ==============================================================================

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$DIR"

echo "=========================================================="
echo "    Iniciando Evolution API v2 & PostgreSQL (Warnat Tech)  "
echo "=========================================================="

if [ ! -f .env ]; then
    echo "[!] Arquivo .env não encontrado. Copiando de .env.example..."
    cp .env.example .env
    echo "[✓] Arquivo .env criado."
fi

docker compose up -d

if [ $? -eq 0 ]; then
    echo "[✓] Containers iniciados com sucesso!"
    docker compose ps
else
    echo "[ERRO] Falha ao subir containers. Verifique os logs com: docker compose logs -f"
fi
