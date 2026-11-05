#!/bin/bash
# ==============================================================================
# Script para Conexão de Instância / Exibição do QR Code (Linux / Bash)
# ==============================================================================

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$DIR"

if [ ! -f .env ]; then
    echo "[ERRO] Arquivo .env não encontrado."
    exit 1
fi

set -a
source .env
set +a

SERVER_URL=${SERVER_URL:-http://localhost:8080}
INSTANCE_NAME=${INSTANCE_NAME:-warnat-tech}

CONNECT_URL="$SERVER_URL/instance/connect/$INSTANCE_NAME"

echo "=========================================================="
echo "         Conectando WhatsApp: $INSTANCE_NAME              "
echo "=========================================================="
echo "Abra o navegador e acesse a URL abaixo para escanear o QR Code:"
echo ""
echo "$CONNECT_URL"
echo ""
echo "No seu celular:"
echo "1. WhatsApp > Aparelhos Conectados > Conectar Aparelho"
echo "2. Escaneie o QR Code na tela."
