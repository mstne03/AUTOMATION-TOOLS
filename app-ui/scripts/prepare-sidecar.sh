#!/usr/bin/env bash
# Copia el sidecar compilado por PyInstaller (app-backend/dist/app-backend) a src-tauri/binaries
# con el nombre que exige Tauri para externalBin (sufijo del target triple), y la carpeta
# _internal como recurso. Borra antes la copia anterior y la que `tauri build` deja en
# target/release, para que un instalador nunca lleve un sidecar viejo (pitfall del informe 2.1).
#
#   bash scripts/prepare-sidecar.sh        # desde app-ui/
set -euo pipefail
cd "$(dirname "$0")/.."
DIST=../app-backend/dist/app-backend
TRIPLE=$(rustc -vV | sed -n 's/^host: //p')
[ -f "$DIST/app-backend.exe" ] || { echo "Falta $DIST/app-backend.exe: compila antes con PyInstaller (app-backend/README.md)." >&2; exit 1; }

rm -rf src-tauri/binaries/_internal src-tauri/binaries/app-backend-*.exe
rm -rf src-tauri/target/release/app-backend.exe src-tauri/target/release/_internal src-tauri/target/release/resources
cp "$DIST/app-backend.exe" "src-tauri/binaries/app-backend-$TRIPLE.exe"
cp -r "$DIST/_internal" src-tauri/binaries/_internal
sha256sum "src-tauri/binaries/app-backend-$TRIPLE.exe"
echo "Sidecar listo en src-tauri/binaries ($(du -sh src-tauri/binaries | cut -f1))"
