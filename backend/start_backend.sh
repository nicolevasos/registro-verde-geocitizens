#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
python3 -m uvicorn backend.app:app --host 127.0.0.1 --port 5050 --reload
