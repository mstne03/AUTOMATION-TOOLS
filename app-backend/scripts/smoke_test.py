"""Test de arranque del binario empaquetado (se ejecuta en CI tras PyInstaller).

    uv run python scripts/smoke_test.py [dist/app-backend/app-backend.exe]

Hace lo mismo que Tauri: lanza el .exe con APP_BACKEND_TOKEN, lee la primera linea de
stdout (`{"port": N, "token": "..."}`), llama a GET /settings con el token y a
GET /kb/buscar (que carga el modelo de embeddings EMBEBIDO con KB_UPDATE_URL apuntando a
un puerto cerrado; fastembed usa specific_model_path y no consulta HuggingFace), y cierra
el proceso. Comprueba tambien que HF_HUB_OFFLINE NO esta en el entorno del hijo: si
estuviera, faster-whisper no podria bajar su modelo en la primera transcripcion (E1 de
la Fase 5). Estado en un directorio temporal con secretos en fichero: no toca
el Credential Manager ni LOCALAPPDATA/seo-studio.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

TOKEN = "smoke-test-token"


def get(base: str, ruta: str, token: str = TOKEN) -> tuple[int, str]:
    req = urllib.request.Request(base + ruta, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def main() -> int:
    exe = Path(sys.argv[1] if len(sys.argv) > 1 else "dist/app-backend/app-backend.exe").resolve()
    assert exe.is_file(), f"No existe {exe}"
    estado = tempfile.mkdtemp(prefix="app-backend-smoke-")
    env = {
        **os.environ,
        "APP_BACKEND_TOKEN": TOKEN,
        "APP_BACKEND_DIR": estado,
        "APP_BACKEND_SECRETS": "file",
        "KB_UPDATE_URL": "http://127.0.0.1:9/kb/",  # puerto discard: falla rapido, sin red
    }
    env.pop("HF_HUB_OFFLINE", None)  # el hijo no debe heredarla ni fijarla el mismo
    proc = subprocess.Popen([str(exe)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=exe.parent)
    try:
        t0 = time.time()
        linea = proc.stdout.readline().decode().strip()
        assert linea, f"El binario termino sin anunciar el puerto (codigo {proc.poll()}):\n{proc.stderr.read().decode()}"
        info = json.loads(linea)
        assert info["token"] == TOKEN, "El token anunciado no es el de APP_BACKEND_TOKEN"
        base = f"http://127.0.0.1:{info['port']}"
        print(f"Puerto anunciado en {time.time() - t0:.1f} s: {base}")

        st, cuerpo = get(base, "/settings", token="malo")
        assert st == 401, f"Sin token valido deberia dar 401, dio {st}"
        st, cuerpo = get(base, "/settings")
        assert st == 200, f"GET /settings -> {st}: {cuerpo}"
        s = json.loads(cuerpo)
        assert s["state_dir"] == estado and s["secret_store"] == "FileSecretStore", s
        assert s.get("hf_hub_offline") is None, (
            f"HF_HUB_OFFLINE={s.get('hf_hub_offline')!r} en el sidecar: Whisper no podria bajar su modelo"
        )
        print(f"GET /settings OK en {time.time() - t0:.1f} s (modelo {s['model']})")

        st, cuerpo = get(base, "/kb/buscar?q=retencion%20en%20youtube")
        assert st == 200, f"GET /kb/buscar -> {st}: {cuerpo}"
        print(f"GET /kb/buscar OK en {time.time() - t0:.1f} s (modelo de embeddings cargado sin red)")
        return 0
    finally:
        proc.kill()
        proc.wait(timeout=30)
        err = proc.stderr.read().decode(errors="replace")
        if "Traceback" in err or "No se pudo precargar" in err:
            print("---- stderr del sidecar ----\n" + err, file=sys.stderr)
            if "No se pudo precargar" in err:
                print("ERROR: el modelo de embeddings no cargo offline.", file=sys.stderr)
                sys.exit(1)


if __name__ == "__main__":
    sys.exit(main())
