#!/bin/zsh
set -euo pipefail

cd "/Users/makslas/Desktop/Development-Repos/VoiceOS-Discord-MCP"

if [[ -f ".env" ]]; then
  set -a
  source ".env"
  set +a
fi

exec "/Users/makslas/.nvm/versions/node/v22.16.0/bin/npx" tsx "/Users/makslas/Desktop/Development-Repos/VoiceOS-Discord-MCP/index.ts"
