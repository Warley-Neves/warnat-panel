#!/bin/bash
# ==============================================================================
# Script de Criação de Instância (Linux / Bash)
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
INSTANCE_TOKEN=${INSTANCE_TOKEN:-token-interno-warnat-123}
INTEGRATION=${INTEGRATION:-WHATSAPP-BAILEYS}

echo "=========================================================="
echo "    Criando Instância: $INSTANCE_NAME na Evolution API   "
echo "=========================================================="

curl -s -X POST "$SERVER_URL/instance/create" \
  -H "apikey: $AUTHENTICATION_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"instanceName\": \"$INSTANCE_NAME\",
    \"token\": \"$INSTANCE_TOKEN\",
    \"qrcode\": true,
    \"integration\": \"$INTEGRATION\"
  }" | jq . || cat

echo ""
echo "=========================================================="
echo "Para conectar via QR Code no navegador, acesse:"
echo "$SERVER_URL/instance/connect/$INSTANCE_NAME"
echo "=========================================================="
