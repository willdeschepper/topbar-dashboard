#!/usr/bin/env bash
# Gera o zip para enviar ao extensions.gnome.org
set -e
cd "$(dirname "$0")"
mkdir -p dist
gnome-extensions pack --force --out-dir=dist --podir=po \
  --extra-source=dashboard.js \
  --extra-source=widgets.js \
  --extra-source=services.js \
  --extra-source=config.js \
  --extra-source=LICENSE
ls -1 dist/*.zip
