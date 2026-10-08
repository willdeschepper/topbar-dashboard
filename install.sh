#!/usr/bin/env bash
# Instala a extensão a partir desta pasta (uso local / desenvolvimento)
set -e
cd "$(dirname "$0")"
UUID=topbar-dashboard@4rweb.net
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
mkdir -p "$DEST/schemas"
cp extension.js prefs.js dashboard.js widgets.js services.js config.js \
   metadata.json stylesheet.css LICENSE "$DEST/"
cp schemas/*.gschema.xml "$DEST/schemas/"
glib-compile-schemas "$DEST/schemas/"

# Traduções
if command -v msgfmt >/dev/null; then
  for po in po/*.po; do
    lang=$(basename "$po" .po)
    mkdir -p "$DEST/locale/$lang/LC_MESSAGES"
    msgfmt "$po" -o "$DEST/locale/$lang/LC_MESSAGES/$UUID.mo"
  done
else
  echo "Aviso: msgfmt não encontrado, a extensão vai ficar em inglês. Instale com: sudo apt install gettext"
fi
echo "Instalado em $DEST"
