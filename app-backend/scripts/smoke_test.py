"""Test de arranque del binario empaquetado (se ejecuta en CI tras PyInstaller).

    uv run python scripts/smoke_test.py [dist/app-backend/app-backend.exe] [--video-engine RUTA]

Hace lo mismo que Tauri: lanza el .exe con APP_BACKEND_TOKEN, lee la primera linea de
stdout (`{"port": N, "token": "..."}`), llama a GET /settings con el token y a
GET /kb/buscar (que carga el modelo de embeddings EMBEBIDO con KB_UPDATE_URL apuntando a
un puerto cerrado; fastembed usa specific_model_path y no consulta HuggingFace), y cierra
el proceso. Comprueba tambien que HF_HUB_OFFLINE NO esta en el entorno del hijo: si
estuviera, faster-whisper no podria bajar su modelo en la primera transcripcion (E1 de
la Fase 5). Estado en un directorio temporal con secretos en fichero: no toca
el Credential Manager ni LOCALAPPDATA/seo-studio.

Motor de vídeo: si existe `<exe>.parent/video-engine` (o se pasa `--video-engine RUTA`),
comprueba GET /video/capacidades contra el motor del bundle: HyperFrames 0.8.206, telemetría
desactivada, ffmpeg LGPL (sin libx264) y Chrome, ambos del propio bundle. El binario congelado
no acepta ninguna ruta alternativa para el motor (seguridad): con `--video-engine` se crea una
unión de directorios (junction) `<exe>.parent/video-engine` -> RUTA solo durante la prueba y se
borra al acabar (solo la unión, nunca el contenido de RUTA). Si ya hay una carpeta real con ese
nombre, se usa tal cual.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

TOKEN = "smoke-test-token"
HYPERFRAMES = "0.8.206"
FFMPEG = "n7.1.5"  # el LGPL de la tarea 2; el de winget (8.1) delataría que no se usa el bundle


def get(base: str, ruta: str, token: str = TOKEN, timeout: float = 120) -> tuple[int, str]:
    req = urllib.request.Request(base + ruta, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def preparar_motor(motor: Path, ruta: str | None) -> tuple[bool, str | None]:
    """Deja el motor en `motor` si se pidió con --video-engine. Devuelve (hay_motor, qué_borrar)."""
    if ruta is None:
        return motor.is_dir(), None
    origen = Path(ruta).resolve()
    assert (origen / "node" / "node.exe").is_file(), f"--video-engine {origen} no es un motor empaquetado"
    if motor.is_junction():
        os.rmdir(motor)  # unión de una ejecución anterior interrumpida: se rehace
    elif motor.is_dir():
        print(f"Uso el motor que ya hay en {motor} (carpeta real; ignoro --video-engine)")
        return True, None
    # mklink /J no pide permisos de administrador (a diferencia de un symlink).
    r = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(motor), str(origen)],
        check=False,
        capture_output=True,
        text=True,
        errors="replace",
    )
    if r.returncode == 0 and motor.is_junction():
        return True, "union"
    print(f"No pude crear la unión ({r.stdout.strip()} {r.stderr.strip()}); copio el motor", file=sys.stderr)
    shutil.copytree(origen, motor)
    return True, "copia"


def retirar_motor(motor: Path, que: str | None) -> None:
    if que == "union":
        assert motor.is_junction(), f"{motor} ya no es una unión: no lo toco"
        os.rmdir(motor)  # borra la unión, no el destino
    elif que == "copia":
        shutil.rmtree(motor)


def comprobar_video(base: str, motor: Path, t0: float) -> None:
    st, cuerpo = get(base, "/video/capacidades", token="malo")
    assert st == 401, f"GET /video/capacidades sin token valido deberia dar 401, dio {st}"
    # Con el estado vacío el motor hace su prueba de GPU (un render corto): puede tardar un minuto.
    st, cuerpo = get(base, "/video/capacidades", timeout=300)
    assert st == 200, f"GET /video/capacidades -> {st}: {cuerpo}"
    c = json.loads(cuerpo)
    assert c.get("hyperframes") == HYPERFRAMES, f"hyperframes={c.get('hyperframes')!r}, esperado {HYPERFRAMES}"
    assert (c.get("telemetria") or "").startswith("desactivada"), f"telemetria={c.get('telemetria')!r}"
    ffmpeg = c.get("ffmpeg") or ""
    assert ffmpeg and "--enable-libx264" not in ffmpeg, f"ffmpeg={ffmpeg!r}"
    assert FFMPEG in ffmpeg, f"ffmpeg={ffmpeg!r}: no es el ffmpeg LGPL del bundle"
    chrome = c.get("chrome") or ""
    assert chrome.lower().startswith(str(motor / "browser").lower()), f"chrome={chrome!r}: no es el del bundle"
    print(f"GET /video/capacidades OK en {time.time() - t0:.1f} s")
    print(f"  hyperframes {c['hyperframes']} · telemetria {c['telemetria']}")
    print(f"  {ffmpeg}")
    print(f"  chrome {chrome}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("exe", nargs="?", default="dist/app-backend/app-backend.exe")
    ap.add_argument("--video-engine", metavar="RUTA", help="motor empaquetado (prepare-video-engine.sh)")
    args = ap.parse_args()
    exe = Path(args.exe).resolve()
    assert exe.is_file(), f"No existe {exe}"
    motor = exe.parent / "video-engine"
    hay_motor, retirar = preparar_motor(motor, args.video_engine)
    try:
        return arrancar_y_comprobar(exe, motor if hay_motor else None)
    finally:
        retirar_motor(motor, retirar)


def arrancar_y_comprobar(exe: Path, motor: Path | None) -> int:
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

        if motor is None:
            print("Sin video-engine junto al binario: no compruebo el motor de vídeo")
        else:
            comprobar_video(base, motor, t0)
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
