#!/bin/bash
# ==============================================================================
# Script de Parada dos Serviços (Linux / Bash)
# ==============================================================================

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$DIR"

echo "Parando containers da Evolution API..."
docker compose down

echo "[✓] Containers finalizados."
