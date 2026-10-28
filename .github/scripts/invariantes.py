"""Reglas de seguridad del producto que no se reabren (CLAUDE.md), comprobadas en cada PR.

    python .github/scripts/invariantes.py      # desde la raíz del repo; solo biblioteca estándar

Cada regla protege una decisión de diseño; si una falla, o el cambio la rompe sin querer o la
decisión se está reabriendo, y eso se discute en la PR, no se cuela.
"""

import json
import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
TAURI = RAIZ / "app-ui" / "src-tauri"
fallos: list[str] = []


def regla(ok: bool, mensaje: str) -> None:
    if not ok:
        fallos.append(mensaje)


# 1. El WebView solo tiene core:default: lo nativo va por comandos Rust.
for cap in sorted((TAURI / "capabilities").glob("*.json")):
    permisos = json.loads(cap.read_text(encoding="utf-8")).get("permissions", [])
    regla(permisos == ["core:default"], f"{cap.name}: permisos {permisos}, solo se admite core:default")

# 2. CSP: nada de eval, todo 'self' salvo el sidecar local.
seguridad = json.loads((TAURI / "tauri.conf.json").read_text(encoding="utf-8"))["app"]["security"]
csp = seguridad.get("csp") or ""
directivas = {d.split()[0]: d.split()[1:] for d in csp.split(";") if d.strip()}
regla(directivas.get("default-src") == ["'self'"], "CSP: default-src tiene que ser solo 'self'")
regla("'unsafe-eval'" not in csp, "CSP: 'unsafe-eval' no se admite")
for directiva, fuentes in directivas.items():
    ajenas = [f for f in fuentes if f.startswith(("http:", "https:", "ws:", "wss:"))
              and not f.startswith(("http://127.0.0.1", "http://ipc.localhost"))]
    regla(not ajenas and "*" not in fuentes, f"CSP: {directiva} admite orígenes externos: {fuentes}")

# 3. Ningún servidor escucha en todas las interfaces: Ollama, LM Studio y el sidecar no
#    tienen más autenticación que estar en 127.0.0.1.
CODIGO = ("app-backend", "kb-seo", "youtube-mcp-server", "video-mcp-server/src")
for carpeta in CODIGO:
    for fichero in (RAIZ / carpeta).rglob("*"):
        if fichero.suffix not in (".py", ".ts", ".mjs") or {".venv", "node_modules", "dist"} & set(fichero.parts):
            continue
        for n, linea in enumerate(fichero.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
            if re.search(r"""["'](0\.0\.0\.0|::)["']""", linea):
                fallos.append(f"{fichero.relative_to(RAIZ)}:{n}: escucha en todas las interfaces")

# 4. docker compose publica puertos solo en 127.0.0.1 ("5433:5432" sería 0.0.0.0:5433).
for compose in RAIZ.glob("*/docker-compose*.yml"):
    for n, linea in enumerate(compose.read_text(encoding="utf-8").splitlines(), 1):
        if re.match(r"""\s*-\s*["']?\d+:\d+""", linea):
            fallos.append(f"{compose.relative_to(RAIZ)}:{n}: puerto publicado sin 127.0.0.1")

# 5. La salida del modelo nunca se pinta como HTML.
for fichero in (RAIZ / "app-ui" / "src").rglob("*.ts*"):
    if "test" in fichero.parts:
        continue
    texto = fichero.read_text(encoding="utf-8")
    if re.search(r"dangerouslySetInnerHTML|\.(inner|outer)HTML\s*=|insertAdjacentHTML", texto):
        fallos.append(f"{fichero.relative_to(RAIZ)}: pinta HTML crudo")

for f in fallos:
    print(f"::error::{f}")
print(f"{len(fallos)} invariante(s) rotas" if fallos else "Invariantes de seguridad: OK")
sys.exit(1 if fallos else 0)
