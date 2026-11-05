#!/bin/bash
# ==============================================================================
# Script de Vinculação Evolution API <-> Typebot (Linux / Bash)
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
TYPEBOT_URL=${TYPEBOT_URL:-https://viewer.typebot.io}
TYPEBOT_NAME=${TYPEBOT_NAME:-warnat-atendimento-xyz}
TYPEBOT_EXPIRE=${TYPEBOT_EXPIRE:-20}
TYPEBOT_KEYWORD_FINISH=${TYPEBOT_KEYWORD_FINISH:-#parar}
TYPEBOT_DELAY_MESSAGE=${TYPEBOT_DELAY_MESSAGE:-1500}
TYPEBOT_DEBOUNCE_TIME=${TYPEBOT_DEBOUNCE_TIME:-10}
TYPEBOT_UNKNOWN_MESSAGE=${TYPEBOT_UNKNOWN_MESSAGE:-"Desculpe, não compreendi. Poderia repetir?"}

echo "=========================================================="
echo "    Vinculando Typebot à Instância: $INSTANCE_NAME        "
echo "=========================================================="

curl -s -X POST "$SERVER_URL/typebot/set/$INSTANCE_NAME" \
  -H "apikey: $AUTHENTICATION_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"enabled\": true,
    \"url\": \"$TYPEBOT_URL\",
    \"typebot\": \"$TYPEBOT_NAME\",
    \"expire\": $TYPEBOT_EXPIRE,
    \"keywordFinish\": \"$TYPEBOT_KEYWORD_FINISH\",
    \"delayMessage\": $TYPEBOT_DELAY_MESSAGE,
    \"unknownMessage\": \"$TYPEBOT_UNKNOWN_MESSAGE\",
    \"listeningFromMe\": false,
    \"stopBotFromMe\": true,
    \"keepOpen\": false,
    \"debounceTime\": $TYPEBOT_DEBOUNCE_TIME
  }" | jq . || cat

echo ""
echo "[✓] Configuração enviada para a Evolution API."
