#!/bin/bash
set -euo pipefail

tail -f logs/nanoclaw.log | grep --line-buffered -i ollama