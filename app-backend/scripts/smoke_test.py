"""Test de arranque del binario empaquetado (se ejecuta en CI tras PyInstaller).

    uv run python scripts/smoke_test.py [dist/app-backend/app-backend.exe]
        [--video-engine RUTA (--cft-zip ZIP | --cft-descargar)]

Hace lo mismo que Tauri: lanza el .exe con APP_BACKEND_TOKEN, lee la primera linea de
stdout (`{"port": N, "token": "..."}`), llama a GET /settings con el token y a
GET /kb/buscar (que carga el modelo de embeddings EMBEBIDO con KB_UPDATE_URL apuntando a
un puerto cerrado; fastembed usa specific_model_path y no consulta HuggingFace), y cierra
el proceso. Comprueba tambien que HF_HUB_OFFLINE NO esta en el entorno del hijo: si
estuviera, faster-whisper no podria bajar su modelo en la primera transcripcion (E1 de
la Fase 5). Estado en un directorio temporal con secretos en fichero: no toca
el Credential Manager ni LOCALAPPDATA/seo-studio.

Motor de vídeo: sin `<exe>.parent/video-engine/node/node.exe`, comprueba que GET /video/capacidades da 503
(«módulo de vídeo no instalado»). Si existe (o se pasa `--video-engine RUTA`),
comprueba GET /video/capacidades contra el motor del bundle: HyperFrames 0.8.206, telemetría
desactivada y ffmpeg LGPL (sin libx264) del propio bundle.

Navegador del render (SEO-108): el bundle NO lleva Chrome (I12). Siempre se comprueba
GET /video/navegador (401 sin token, versión fijada). Con motor hace falta uno de los dos:
`--cft-zip ZIP` instala un zip local antes de arrancar (`python -m app_backend.navegador --zip`, mismo
SHA-256 fijado, sin red) o `--cft-descargar` lo baja de verdad con POST /video/navegador/descarga
(CI de release: única salida de red, la de I14, contra la URL y el hash fijados en config.py). Después
`chrome` de /video/capacidades tiene que estar en `<estado>/video/navegador/<versión>/`. El binario congelado
no acepta ninguna ruta alternativa para el motor (seguridad): con `--video-engine` se crea una
unión de directorios (junction) `<exe>.parent/video-engine` -> RUTA solo durante la prueba y se
borra al acabar (solo la unión, nunca el contenido de RUTA). Si ya hay una carpeta real con ese
nombre, `--video-engine` falla en vez de ignorarse: se probaría otro motor sin saberlo.
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
CFT_VERSION = "156.0.8078.73"  # la de config.NAVEGADOR_VERSION
CFT_FICHEROS = 288
APP_BACKEND = Path(__file__).resolve().parents[1]


def get(base: str, ruta: str, token: str = TOKEN, timeout: float = 120) -> tuple[int, str]:
    req = urllib.request.Request(base + ruta, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def post(base: str, ruta: str, token: str = TOKEN, timeout: float = 30) -> tuple[int, str]:
    req = urllib.request.Request(base + ruta, data=b"", method="POST", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def esperar_navegador(base: str, limite: float = 900) -> dict:
    """Sondea GET /video/navegador hasta `listo`; falla con el error del backend si llega a `error`."""
    t0 = time.time()
    while True:
        st, cuerpo = get(base, "/video/navegador")
        assert st == 200, f"GET /video/navegador -> {st}: {cuerpo}"
        e = json.loads(cuerpo)
        if e["estado"] == "listo":
            return e
        assert e["estado"] != "error", f"La descarga del navegador falló: {e['error']}"
        assert time.time() - t0 < limite, f"La descarga del navegador no terminó en {limite:g} s: {e}"
        time.sleep(2)


def comprobar_navegador(base: str, cft_zip: str | None, cft_descargar: bool) -> None:
    st, _ = get(base, "/video/navegador", token="malo")
    assert st == 401, f"GET /video/navegador sin token valido deberia dar 401, dio {st}"
    st, cuerpo = get(base, "/video/navegador")
    assert st == 200, f"GET /video/navegador -> {st}: {cuerpo}"
    e = json.loads(cuerpo)
    assert e["version"] == CFT_VERSION, e
    if cft_descargar:
        st, cuerpo = post(base, "/video/navegador/descarga")
        assert st == 202, f"POST /video/navegador/descarga -> {st}: {cuerpo}"
        t0 = time.time()
        e = esperar_navegador(base)
        print(f"Navegador descargado y verificado en {time.time() - t0:.1f} s ({e['descargado']} bytes)")
        # Ya instalado: otro POST termina en `listo` sin bajar nada.
        st, cuerpo = post(base, "/video/navegador/descarga")
        assert st == 202, f"POST /video/navegador/descarga (2.º) -> {st}: {cuerpo}"
        e = esperar_navegador(base, 120)
        assert e["descargado"] == 0, f"El segundo POST volvió a descargar: {e}"
    else:
        esperado = "listo" if cft_zip else "ausente"
        assert e["estado"] == esperado, f"estado={e['estado']!r}, esperado {esperado!r}"
    print(f"GET /video/navegador OK: {e['estado']}")


def preparar_motor(motor: Path, ruta: str | None, creado: list[str]) -> bool:
    """Deja el motor en `motor` si se pidió con --video-engine; anota en `creado` qué hay que retirar.

    Se anota antes de crear nada, para que `retirar_motor` limpie también una copia a medias.
    """
    if ruta is None:
        # Sin VIDEO_ENGINE el release deja video-engine/ con solo un marcador (.vacio): no es un motor.
        return (motor / "node" / "node.exe").is_file()
    origen = Path(ruta).resolve()
    assert (origen / "node" / "node.exe").is_file(), f"--video-engine {origen} no es un motor empaquetado"
    if motor.is_junction():
        os.rmdir(motor)  # unión de una ejecución anterior interrumpida: se rehace
    assert not motor.exists(), (
        f"Ya hay una carpeta real {motor}: quítala o no pases --video-engine (se usaría esa, no {origen})"
    )
    creado.append("union")
    # mklink /J no pide permisos de administrador (a diferencia de un symlink).
    r = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(motor), str(origen)],
        check=False,
        capture_output=True,
        text=True,
        errors="replace",
    )
    if r.returncode == 0 and motor.is_junction():
        return True
    print(f"No pude crear la unión ({r.stdout.strip()} {r.stderr.strip()}); copio el motor", file=sys.stderr)
    creado[-1] = "copia"
    shutil.copytree(origen, motor)
    return True


def retirar_motor(motor: Path, creado: list[str]) -> None:
    if not creado:
        return
    if creado[-1] == "union":
        if motor.is_junction():
            os.rmdir(motor)  # borra la unión, no el destino
        else:
            assert not motor.exists(), f"{motor} ya no es una unión: no lo toco"
    elif motor.exists():  # copia (quizá a medias): es nuestra
        shutil.rmtree(motor)


def comprobar_video(base: str, motor: Path, estado: str, t0: float) -> None:
    st, cuerpo = get(base, "/video/capacidades", token="malo")
    assert st == 401, f"GET /video/capacidades sin token valido deberia dar 401, dio {st}"
    # Con el estado vacío el motor hace su prueba de GPU (un render corto): puede tardar minutos. El
    # cliente espera más que el servidor (TIMEOUT_CAPACIDADES, 420 s): si el motor se cuelga, se ve
    # el 502 del backend con su mensaje y no un timeout mudo del cliente.
    st, cuerpo = get(base, "/video/capacidades", timeout=480)
    assert st == 200, f"GET /video/capacidades -> {st}: {cuerpo}"
    c = json.loads(cuerpo)
    assert c.get("hyperframes") == HYPERFRAMES, f"hyperframes={c.get('hyperframes')!r}, esperado {HYPERFRAMES}"
    assert (c.get("telemetria") or "").startswith("desactivada"), f"telemetria={c.get('telemetria')!r}"
    ffmpeg = c.get("ffmpeg") or ""
    assert ffmpeg and "--enable-libx264" not in ffmpeg, f"ffmpeg={ffmpeg!r}"
    assert FFMPEG in ffmpeg, f"ffmpeg={ffmpeg!r}: no es el ffmpeg LGPL del bundle"
    chrome = c.get("chrome") or ""
    carpeta = Path(estado) / "video" / "navegador" / CFT_VERSION
    assert chrome.lower().startswith(str(carpeta).lower()), f"chrome={chrome!r}: no es el de {carpeta}"
    manifiesto = json.loads((carpeta / "MANIFIESTO-SHA256.json").read_text(encoding="utf-8"))
    assert len(manifiesto["ficheros"]) == CFT_FICHEROS, f"manifiesto con {len(manifiesto['ficheros'])} ficheros"
    assert not (motor / "browser").exists(), f"{motor / 'browser'} existe: el bundle no debe llevar Chrome (I12)"
    print(f"GET /video/capacidades OK en {time.time() - t0:.1f} s")
    print(f"  hyperframes {c['hyperframes']} · telemetria {c['telemetria']}")
    print(f"  {ffmpeg}")
    print(f"  chrome {chrome}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("exe", nargs="?", default="dist/app-backend/app-backend.exe")
    ap.add_argument("--video-engine", metavar="RUTA", help="motor empaquetado (prepare-video-engine.sh)")
    cft = ap.add_mutually_exclusive_group()
    cft.add_argument("--cft-zip", metavar="ZIP", help="instala el CfT desde un zip local (sin red)")
    cft.add_argument("--cft-descargar", action="store_true", help="descarga el CfT de verdad (CI de release)")
    args = ap.parse_args()
    assert not args.video_engine or args.cft_zip or args.cft_descargar, (
        "Con --video-engine hace falta --cft-zip ZIP o --cft-descargar: el bundle no lleva navegador"
    )
    exe = Path(args.exe).resolve()
    assert exe.is_file(), f"No existe {exe}"
    motor = exe.parent / "video-engine"
    creado: list[str] = []
    try:
        hay_motor = preparar_motor(motor, args.video_engine, creado)
        assert hay_motor or not args.cft_descargar, "--cft-descargar necesita el motor de vídeo"
        return arrancar_y_comprobar(exe, motor if hay_motor else None, args.cft_zip, args.cft_descargar)
    finally:
        retirar_motor(motor, creado)


def arrancar_y_comprobar(exe: Path, motor: Path | None, cft_zip: str | None, cft_descargar: bool) -> int:
    estado = tempfile.mkdtemp(prefix="app-backend-smoke-")
    if cft_zip:
        # Antes de arrancar el binario y por el mismo camino que la descarga (hash fijado incluido).
        subprocess.run(
            [sys.executable, "-m", "app_backend.navegador", "--zip", str(Path(cft_zip).resolve())],
            env={**os.environ, "APP_BACKEND_DIR": estado, "APP_BACKEND_SECRETS": "file"},
            cwd=APP_BACKEND,
            check=True,
        )
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

        comprobar_navegador(base, cft_zip, cft_descargar)
        if motor is None:
            # Release sin VIDEO_ENGINE: el módulo no instalado es un 503 legible, no un 500.
            st, cuerpo = get(base, "/video/capacidades")
            assert st == 503 and "no está instalado" in json.loads(cuerpo)["detail"], (
                f"GET /video/capacidades sin motor -> {st}: {cuerpo}"
            )
            print("Sin video-engine junto al binario: GET /video/capacidades da 503 (módulo no instalado)")
        else:
            comprobar_video(base, motor, estado, t0)
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
