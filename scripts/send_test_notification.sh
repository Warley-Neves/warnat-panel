#!/bin/bash
# ==============================================================================
# Script de Teste de Notificação / Webhook (Linux / Bash)
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
NOTIFICATION_PHONE=${NOTIFICATION_PHONE:-5531999999999}

echo "=========================================================="
echo "   Enviando Notificação de Teste via Evolution API        "
echo "=========================================================="
echo "Destinatário: $NOTIFICATION_PHONE"

curl -s -X POST "$SERVER_URL/message/sendText/$INSTANCE_NAME" \
  -H "apikey: $AUTHENTICATION_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"number\": \"$NOTIFICATION_PHONE\",
    \"text\": \"🚨 *NOVO AGENDAMENTO DE VISITA - WARNAT TECH*\\n\\n*Tipo:* Para minha empresa (TESTE)\\n*Problema:* Cabeamento estruturado e lentidão de rede\\n*Bairro:* Centro Empresarial\\n*Período:* Prefiro pela manhã\\n*Dados do Cliente:* João Silva - Av. Paulista, 1000 - Sala 402\"
  }" | jq . || cat

echo ""
echo "[✓] Requisição concluída."
