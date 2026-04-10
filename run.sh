#!/bin/bash
set -e
cd "$(dirname "$0")"

if [ ! -d "venv" ]; then
  python3 -m venv venv
  venv/bin/pip install -q -r requirements.txt
fi

mkdir -p data

exec venv/bin/uvicorn app.main:app \
  --host "${HOST:-127.0.0.1}" \
  --port "${PORT:-8080}"
