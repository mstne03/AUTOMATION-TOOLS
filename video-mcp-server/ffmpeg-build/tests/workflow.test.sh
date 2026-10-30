#!/usr/bin/env bash
# El workflow ffmpeg-lgpl.yml cumple las reglas de R0 H2/L2 y R1: sin cachés, permisos mínimos por
# job, `push` solo con pruebas, publicación solo desde main y comparando SHA-256.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
W="$DIR_BUILD/../../.github/workflows/ffmpeg-lgpl.yml"
if [ ! -f "$W" ]; then echo "  OMITIDO: sin el workflow (árbol del código fuente correspondiente)"; fin; exit 0; fi
# Bloque de un job sin comentarios (de línea ni al final): un comentario no puede satisfacer el test.
bloque() { awk -v j="  $1:" '/^[[:space:]]*#/ {next} {sub(/[ 	]+#.*$/, "")} $0 == j {f = 1; print; next} f && /^  [a-z]/ {f = 0} f' "$W"; }
sin_comentarios=$(grep -v '^[[:space:]]*#' "$W")

# Sin cachés de ningún tipo.
for p in 'actions/cache' 'type=gha' 'cache-from' 'cache-to' 'cache:' 'enable-cache'; do
  negar "sin '$p'" grep -qF -- "$p" <<<"$sin_comentarios"
done

# Disparadores: push solo en main y solo el job pruebas; lo demás, solo a mano.
afirmar "permissions: {} en el workflow" grep -qx 'permissions: {}' "$W"
afirmar "push limitado a branches: [main]" bash -c "awk '/^  push:/ {f = 1} f && /branches:/ {print; exit}' '$W' | grep -q 'branches: \[main\]'"
negar "pruebas no tiene if (corre siempre)" grep -q '^    if:' <<<"$(bloque pruebas)"
for j in construir verificar empaquetar publicar; do
  afirmar "$j solo con workflow_dispatch" grep -qE "^    if: github\.event_name == 'workflow_dispatch'( |$)" <<<"$(bloque "$j")"
done

# Permisos por job (L2).
for j in pruebas verificar empaquetar; do
  afirmar "$j con permissions: {}" grep -qx '    permissions: {}' <<<"$(bloque "$j")"
done
afirmar "construir con contents: read" grep -qx '      contents: read' <<<"$(bloque construir)"
for j in pruebas construir verificar empaquetar; do
  negar "$j sin permisos de escritura" grep -q ': write' <<<"$(bloque "$j")"
done

# publicar: main, merge-base, environment y comparación de SHA-256 (H2, LOW-8).
P=$(bloque publicar)
afirmar "publicar: if con refs/heads/main" grep -q "^    if: .*github.ref == 'refs/heads/main'" <<<"$P"
afirmar "publicar: git merge-base --is-ancestor" grep -q 'git merge-base --is-ancestor "$GITHUB_SHA" origin/main' <<<"$P"
afirmar "publicar: environment: release" grep -qx '    environment: release' <<<"$P"
afirmar "publicar: ESPERADO viene de verificar" grep -qF 'ESPERADO: ${{ needs.verificar.outputs.sha256 }}' <<<"$P"
afirmar "publicar: ESPERADO_FUENTE viene de empaquetar" grep -qF 'ESPERADO_FUENTE: ${{ needs.empaquetar.outputs.sha256 }}' <<<"$P"
# Las comparaciones en sí, con su salida de error: declarar ESPERADO no compara nada.
compara() { { grep -nE "^ +$1 \|\| \{ .*exit 1; \}$" <<<"$P" || true; } | head -1 | cut -d: -f1; }
c1=$(compara '\[ "\$real" = "\$ESPERADO" \]'); c2=$(compara '\[ "\$fuente" = "\$ESPERADO_FUENTE" \]')
afirmar "publicar: real sale del SHA256SUMS descargado" grep -qE '^ +real=\$\(sha256sum SHA256SUMS ' <<<"$P"
afirmar "publicar: fuente sale del tarball descargado" grep -qF 'fuente=$(sha256sum "ffmpeg-fuente-correspondiente-$REV.tar.xz"' <<<"$P"
afirmar "publicar: compara SHA256SUMS con verificar y falla si difiere" test -n "$c1"
afirmar "publicar: compara el tarball con empaquetar y falla si difiere" test -n "$c2"
afirmar "publicar: sha256sum -c SHA256SUMS" grep -qE '^ +sha256sum -c SHA256SUMS$' <<<"$P"
afirmar "publicar: SHA256SUMS con exactamente dos ficheros" grep -qF '"ffmpeg.exe ffprobe.exe"' <<<"$P"
atesta=$(grep -n 'attest-build-provenance' <<<"$P" | cut -d: -f1); crea=$(grep -n 'gh release create' <<<"$P" | cut -d: -f1)
afirmar "publicar: compara antes de atestar y atesta antes de la release" test "${c1:-999}" -lt "${atesta:-0}" -a "${c2:-999}" -lt "${atesta:-0}" -a "${atesta:-999}" -lt "${crea:-0}"
negar "publicar no ejecuta scripts del árbol" grep -q 'bash video-mcp-server' <<<"$P"

# verificar: SHA-256 antes de ejecutar nada y el binario sin acceso a GITHUB_* (LOW-7).
V=$(bloque verificar)
sumas=$(grep -n 'id: sumas' <<<"$V" | cut -d: -f1); primera=$(grep -n 'comparar-builds.sh\|verificar-binario.sh' <<<"$V" | head -1 | cut -d: -f1)
afirmar "verificar: sumas antes de comparar/verificar" test -n "$sumas" -a -n "$primera" -a "${sumas:-0}" -lt "${primera:-0}"
afirmar "verificar-binario sin GITHUB_ENV/OUTPUT/PATH" grep -q 'env -u GITHUB_ENV -u GITHUB_OUTPUT -u GITHUB_PATH' <<<"$V"
afirmar "SIN_MF solo de la entrada explícita" grep -qF "SIN_MF: \${{ inputs.sin_mf && '1' || '0' }}" <<<"$V"

# Acciones fijadas por SHA de 40 hex (o el marcador, que la puerta de construir no deja pasar).
marcador='|PENDIENTE-TAREA-10'; [ "${ESTRICTO:-0}" = 1 ] && marcador=''
while read -r uso; do
  if [[ "$uso" =~ @([0-9a-f]{40}$marcador)$ ]]; then ok "fijada: $uso"; else mal "acción sin fijar por SHA: $uso"; fi
done < <(grep -oE 'uses: [^ ]+' "$W" | cut -d' ' -f2 | sort -u)
checkouts=$(grep -c 'uses: actions/checkout@' "$W"); sin_cred=$(grep -c 'persist-credentials: false' "$W")
afirmar "todo checkout con persist-credentials: false" test "$checkouts" -eq "$sin_cred"

fin
