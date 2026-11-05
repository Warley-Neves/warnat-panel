#!/bin/bash
# ==============================================================================
# Script de Diagnóstico e Status (Linux / Bash)
# ==============================================================================

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$DIR"

echo "=========================================================="
echo "            Status dos Containers Docker                  "
echo "=========================================================="
docker compose ps

if [ -f .env ]; then
    set -a
    source .env
    set +a

    SERVER_URL=${SERVER_URL:-http://localhost:8080}
    INSTANCE_NAME=${INSTANCE_NAME:-warnat-tech}

    echo ""
    echo "=========================================================="
    echo "         Estado da Conexão da Instância: $INSTANCE_NAME   "
    echo "=========================================================="
    curl -s -X GET "$SERVER_URL/instance/connectionState/$INSTANCE_NAME" \
      -H "apikey: $AUTHENTICATION_API_KEY" | jq . || cat
fi
