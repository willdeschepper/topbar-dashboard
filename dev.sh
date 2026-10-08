#!/usr/bin/env bash
# Abre o simulador e reinicia ele sozinho sempre que um arquivo da extensão é salvo.
# Edite os arquivos NESTA pasta: a cada salvamento ele reinstala e reabre o simulador.
cd "$(dirname "$0")"
UUID=topbar-dashboard@willdeschepper.github.io

./install.sh

# O simulador lê a lista de extensões ativas do gsettings
current=$(gsettings get org.gnome.shell enabled-extensions)
if [[ $current != *"$UUID"* ]]; then
  if [[ $current == "@as []" || $current == "[]" ]]; then
    new="['$UUID']"
  else
    new="${current%]}, '$UUID']"
  fi
  gsettings set org.gnome.shell enabled-extensions "$new"
fi

ls *.js stylesheet.css metadata.json schemas/*.xml po/*.po | \
  entr -r sh -c './install.sh >/dev/null && exec dbus-run-session gnome-shell --devkit --wayland' 2>&1 | \
  grep --line-buffered -iE "js error|topbar-dashboard|error|exception"
