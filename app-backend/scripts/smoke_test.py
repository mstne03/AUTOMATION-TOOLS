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
desactivada y ffmpeg LGPL (sin libx264) del propio bundle, cuyo sondeo de codificadores
(`revisarEncoders` integrado) debe pasar: rechaza un ffmpeg con libx264 o libopenh264.

Vídeo, fase 1 (T21): `VIDEO_PRUEBAS_TTS_URL`, `VIDEO_E2E` y `ELEVENLABS_VOICE_ID` se fijan en el entorno del
sidecar con valores centinela y, con motor, se lee el entorno real de sus procesos node (PEB): ninguna de las tres
puede llegar al motor congelado. `/docs`, `/redoc` y `/openapi.json` dan 404 en la API y en los puertos de la preview.
La preview responde en su puerto con su CSP, el runtime del bundle tiene el SHA-256 fijado y el sidecar lo da por
bueno (POST …/preview no falla por puerto ni por runtime).

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

Parche de HyperFrames (SEO-109): con motor, antes de arrancar nada se comprueban los SHA-256 del bundle
(`ficheros` y `sinParche`) y que su JSON sea el del repo. Durante la prueba de GPU, que es un render real
del motor empaquetado, `VigilanteIntegridad` mide la integridad de cada proceso de Chrome: sin ningún
renderer observado, o con uno fuera de Untrusted, el smoke falla (I3, I11). Después lanza un Chrome de
control con --no-sandbox para demostrar que el vigilante distingue. Con `--video-engine`, además, repite
contra una copia del motor con un byte cambiado en el dist: /video/capacidades informa del fallo y no se
lanza Chrome.
"""

import argparse
import ctypes
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from typing import Self

TOKEN ="smoke-test-token"
HYPERFRAMES = "0.8.206"
FFMPEG = "n7.1.5"  # el LGPL de la tarea 2; el de winget (8.1) delataría que no se usa el bundle
CFT_VERSION = "156.0.8078.73"  # la de config.NAVEGADOR_VERSION
CFT_FICHEROS = 288
APP_BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_BACKEND))  # `config` del backend (puertos y hash de la preview): la verdad del repo
from app_backend import config

# Solo para desarrollo y E2E: el sidecar congelado no las reenvía al motor (T21). Centinelas válidos para el motor.
VARIABLES_DE_PRUEBA = {
    "VIDEO_PRUEBAS_TTS_URL": "http://127.0.0.1:9",
    "VIDEO_E2E": "1",
    "ELEVENLABS_VOICE_ID": "voz-smoke-centinela",
}
HASHES_PARCHE = f"hyperframes+{HYPERFRAMES}.sha256.json"

# Nivel de integridad: RID del SID de TokenIntegrityLevel. Negativos: no se pudo leer (ver `_cerrar`).
UNTRUSTED = 0x0000
LOW = 0x1000
SALIO_ANTES = -1  # ya no existía al ir a abrirlo: no hay token que leer
NOMBRES = {
    UNTRUSTED: "Untrusted",
    LOW: "Low",
    0x2000: "Medium",
    0x3000: "High",
    SALIO_ANTES: "salió antes de leerlo",
}
IMAGENES_CHROME = {"chrome-headless-shell.exe", "chrome.exe", "msedge.exe"}
# Los de video-mcp-server/test/hyperframes-comun.ts.
PROXY_NULO = "--proxy-server=0.0.0.0:1"
BYPASS = "--proxy-bypass-list=<-loopback>"
RESOLVER = "--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"
WEBRTC = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"
QUIC = "--disable-quic"
FLAGS_BROWSER = (
    PROXY_NULO,
    RESOLVER,
    WEBRTC,
    QUIC,
    "--disable-accelerated-video-decode",
    "--disable-gpu-sandbox",
    "--hyperframes-owned-browser",
)
BYPASS_VALIDO = re.compile(r"--proxy-bypass-list=<-loopback>(;(localhost|127\.0\.0\.1):\d+)?")
FLAGS_PROHIBIDOS = re.compile(r"--no-sandbox|--single-process|--in-process-gpu")
VIDA_MINIMA_MS = 2000  # menos que esto: sonda o preflight que cerró antes de verle el renderer


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


def post_json(base: str, ruta: str, cuerpo: dict, token: str = TOKEN, timeout: float = 60) -> tuple[int, str]:
    req = urllib.request.Request(
        base + ruta,
        data=json.dumps(cuerpo).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def entorno_de(pid: int) -> dict[str, str]:
    """Entorno de un proceso x64 propio (PEB -> ProcessParameters -> Environment). Sin wmic ni CIM: no lo dan."""
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    n = ctypes.WinDLL("ntdll")
    asa = ctypes.c_void_p
    k.OpenProcess.restype = asa
    k.ReadProcessMemory.argtypes = (asa, asa, asa, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t))
    k.CloseHandle.argtypes = (asa,)
    n.NtQueryInformationProcess.argtypes = (asa, ctypes.c_int, asa, ctypes.c_ulong, asa)
    h = k.OpenProcess(0x0410, False, pid)  # QUERY_INFORMATION | VM_READ
    assert h, f"No pude abrir el proceso {pid} para leer su entorno (error {ctypes.get_last_error()})"
    try:

        def leer(direccion: int, largo: int) -> bytes:
            b = ctypes.create_string_buffer(largo)
            hecho = ctypes.c_size_t(0)
            assert k.ReadProcessMemory(h, direccion, b, largo, ctypes.byref(hecho)), f"ReadProcessMemory {direccion:#x}"
            return b.raw[: hecho.value]

        pbi = (ctypes.c_void_p * 6)()  # PROCESS_BASIC_INFORMATION: el 2.º campo es PebBaseAddress
        assert n.NtQueryInformationProcess(h, 0, pbi, ctypes.sizeof(pbi), None) == 0
        puntero = lambda d: int.from_bytes(leer(d, 8), "little")
        parametros = puntero(pbi[1] + 0x20)  # PEB.ProcessParameters
        entorno, tamano = puntero(parametros + 0x80), puntero(parametros + 0x3F0)  # Environment, EnvironmentSize
        texto = leer(entorno, tamano).decode("utf-16-le")
    finally:
        k.CloseHandle(h)
    pares = (linea.partition("=") for linea in texto.split("\0") if "=" in linea[1:])
    return {nombre.upper(): valor for nombre, _, valor in pares}


def descendientes(raiz: int, imagen: str) -> list[int]:
    """PIDs de los procesos `imagen` que cuelgan de `raiz` (Toolhelp: una instantánea basta, el motor ya está vivo)."""
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
    k.Process32FirstW.argtypes = k.Process32NextW.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
    k.CloseHandle.argtypes = (ctypes.c_void_p,)
    h = k.CreateToolhelp32Snapshot(2, 0)
    filas = []
    try:
        e = _EntradaProceso(dwSize=ctypes.sizeof(_EntradaProceso))
        hay = k.Process32FirstW(h, ctypes.byref(e))
        while hay:
            filas.append((e.th32ProcessID, e.th32ParentProcessID, e.szExeFile.lower()))
            hay = k.Process32NextW(h, ctypes.byref(e))
    finally:
        k.CloseHandle(h)
    arbol, crece = {raiz}, True
    while crece:
        crece = False
        for pid, ppid, _ in filas:
            if ppid in arbol and pid not in arbol:
                arbol.add(pid)
                crece = True
    return [pid for pid, _, img in filas if pid in arbol and pid != raiz and img == imagen]


def comprobar_docs_ausentes(base: str) -> None:
    """Sin /docs, /redoc ni /openapi.json en la API (con token válido: un 401 no probaría nada) ni en la preview."""
    for ruta in ("/docs", "/redoc", "/openapi.json"):
        st, _ = get(base, ruta)
        assert st == 404, f"GET {ruta} en la API -> {st}, esperado 404"
    print("/docs, /redoc y /openapi.json dan 404 en la API")


def sondear_preview(puerto: int, ruta: str = "/docs") -> tuple[int, str | None]:
    """GET sin token a un puerto de la preview, con su `Host`. (0, None) si no hay nadie escuchando."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{puerto}{ruta}", timeout=5) as r:
            return r.status, r.headers.get("Content-Security-Policy")
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Security-Policy")
    except OSError:
        return 0, None


def csp_esperada(puerto: int) -> str:
    """La de `preview.cabecera_csp` con el binario congelado: sin el origen de Vite (`localhost:1420`)."""
    o = f"http://127.0.0.1:{puerto}"
    return (
        "sandbox allow-scripts; default-src 'none'; "
        f"script-src {o} 'unsafe-inline'; style-src {o} 'unsafe-inline'; img-src {o} data: blob:; "
        f"font-src {o} data:; media-src {o} blob:; connect-src {o}; worker-src 'none'; "
        "base-uri 'none'; form-action 'none'; frame-ancestors http://tauri.localhost https://tauri.localhost"
    )


def comprobar_preview(base: str, motor: Path | None) -> None:
    """La preview responde en su puerto con su CSP, su runtime es el fijado y el sidecar lo da por bueno."""
    vivos = {}
    for puerto in config.PUERTOS_PREVIEW:
        st, csp = sondear_preview(puerto)
        if st:
            vivos[puerto] = (st, csp)
    propios = {p: v for p, v in vivos.items() if v[1] is not None}
    assert propios, f"Ningún puerto de la preview {config.PUERTOS_PREVIEW} responde con CSP: {vivos}"
    for puerto, (st, csp) in propios.items():
        assert st == 404, f"GET /docs en el puerto de la preview {puerto} -> {st}, esperado 404"
        assert csp == csp_esperada(puerto), f"CSP de la preview en {puerto}: {csp!r}, esperada {csp_esperada(puerto)!r}"
        st, csp = sondear_preview(puerto, "/p/inexistente/index.html")
        assert st == 404 and csp == csp_esperada(puerto), f"clave inexistente en {puerto} -> {st}, csp={csp!r}"
    print(f"La preview responde con su CSP en el puerto {sorted(propios)} (404 en /docs y con clave inexistente)")
    if motor is None:
        return
    runtime = motor / "app" / Path(*config.RUNTIME_PREVIEW_REL)
    sha = hashlib.sha256(runtime.read_bytes()).hexdigest()
    assert sha == config.RUNTIME_SHA256, f"El runtime del bundle {runtime} tiene SHA-256 {sha}, no el fijado"
    # Un proyecto sin voz no se puede montar (haría falta ElevenLabs: sin red en el smoke), pero el POST solo
    # llega al motor si el sidecar ya reservó puerto y verificó el runtime: un 503 aquí es uno de los dos fallos.
    guion = {
        "version": 1,
        "titulo": "Smoke",
        "gancho": "Hola",
        "escenas": [{"frases": ["Hola."], "base": {"tipo": "cartel", "texto": "Hola"}}],
        "opciones": {"fondo": "ninguno", "look": "normal", "subtitulos": "karaoke", "destellos": []},
    }
    st, cuerpo = post_json(base, "/video/guiones", {"guion": guion})
    assert st in (200, 201), f"POST /video/guiones -> {st}: {cuerpo}"
    st, cuerpo = post_json(base, "/video/proyectos", {"guion_id": json.loads(cuerpo)["id"], "perfil_id": "defecto"})
    assert st in (200, 201), f"POST /video/proyectos -> {st}: {cuerpo}"
    st, cuerpo = post_json(base, f"/video/proyectos/{json.loads(cuerpo)['id']}/preview", {})
    assert st != 503, f"POST …/preview -> 503 (sin puerto de la preview o runtime no verificado): {cuerpo}"
    print(f"Runtime de la preview con el SHA-256 fijado; el sidecar lo acepta (POST …/preview sin voz -> {st})")


def comprobar_motor_sin_pruebas(sidecar: int) -> None:
    """El entorno de los procesos node del motor no lleva ninguna variable de pruebas (T21, I14)."""
    nodos = descendientes(sidecar, "node.exe")
    assert nodos, "No hay ningún node.exe colgando del sidecar: el motor no está vivo para medir su entorno"
    for pid in nodos:
        env = entorno_de(pid)
        assert env.get("VIDEO_ENGINE_EMBEDDED") == "1", f"node.exe #{pid} no parece el motor (sin VIDEO_ENGINE_EMBEDDED)"
        colados = sorted(set(VARIABLES_DE_PRUEBA) & set(env))
        assert not colados, f"El motor congelado (#{pid}) recibió variables de pruebas: {colados}"
    print(f"Entorno del motor OK: {len(nodos)} proceso(s) node sin {sorted(VARIABLES_DE_PRUEBA)}")


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


def comprobar_parche_bundle(motor: Path) -> None:
    """Falla si el bundle no lleva el parche fijado: lo mismo que verificarDist, pero contra el repo."""
    bundle = motor / "app" / "patches" / HASHES_PARCHE
    assert bundle.is_file(), f"Falta {bundle}: sin ese JSON el motor se niega a lanzar la CLI"
    repo = APP_BACKEND.parent / "video-mcp-server" / "patches" / HASHES_PARCHE
    fijado = json.loads(repo.read_text("utf-8"))
    assert json.loads(bundle.read_text("utf-8")) == fijado, f"{bundle} no es el JSON del repo"
    assert fijado["version"] == HYPERFRAMES, f"JSON de hyperframes {fijado['version']}, no de {HYPERFRAMES}"
    assert fijado["ficheros"] and fijado["sinParche"], "El JSON de hashes no lista ficheros"
    hf = motor / "app" / "node_modules" / "hyperframes"
    version = json.loads((hf / "package.json").read_text("utf-8"))["version"]
    assert version == HYPERFRAMES, f"El bundle trae hyperframes {version}, no {HYPERFRAMES}"
    esperados = {**fijado["ficheros"], **fijado["sinParche"]}
    distintos = [
        rel
        for rel, sha in esperados.items()
        if not (hf / rel).is_file() or hashlib.sha256((hf / rel).read_bytes()).hexdigest() != sha
    ]
    assert not distintos, f"Parche de HyperFrames sin aplicar en el bundle (I3): {distintos}"
    print(f"Parche del bundle OK: {len(esperados)} ficheros con el SHA-256 fijado")


class _EntradaProceso(ctypes.Structure):  # PROCESSENTRY32W
    _fields_ = [
        ("dwSize", ctypes.c_ulong),
        ("cntUsage", ctypes.c_ulong),
        ("th32ProcessID", ctypes.c_ulong),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", ctypes.c_ulong),
        ("cntThreads", ctypes.c_ulong),
        ("th32ParentProcessID", ctypes.c_ulong),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", ctypes.c_ulong),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


class VigilanteIntegridad:
    """Procesos de Chrome descendientes de `raiz` mientras dura el `with`, con su integridad.

    Muestrea con Toolhelp y retiene un asa de cada descendiente desde que lo ve: el token sigue legible
    tras la salida y Windows no reutiliza el PID. Por eso el nivel se lee una sola vez, al salir del
    `with`, y no depende del muestreo (I3-causa: la sonda de GPU baja a Untrusted y sale en 30-60 ms).
    Con `ctypes`, sin wmic ni CIM: tardan ~1 s por consulta y un proceso muerto ya no da línea de comandos.
    """

    PERIODO = 0.03

    def __init__(self, navegador: Path, raiz: int):
        self.carpeta = os.path.normcase(os.path.realpath(navegador)) + os.sep
        self.raiz = raiz
        self._arbol = {raiz}
        self._asas: dict[int, int] = {}
        self._errores: dict[int, int] = {}
        self._vistos: dict[int, dict] = {}
        self._fin = threading.Event()
        self._hilo = threading.Thread(target=self._bucle, daemon=True)

    def __enter__(self) -> Self:
        # Instancias propias: fijar `restype` en ctypes.windll afectaría a todo el proceso.
        k = self._k = ctypes.WinDLL("kernel32", use_last_error=True)
        a = self._a = ctypes.WinDLL("advapi32", use_last_error=True)
        n = self._n = ctypes.WinDLL("ntdll")
        asa, puntero, dword = ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong
        k.CreateToolhelp32Snapshot.restype = asa
        k.OpenProcess.restype = asa
        k.Process32FirstW.argtypes = k.Process32NextW.argtypes = (asa, puntero)
        k.CloseHandle.argtypes = (asa,)
        k.GetExitCodeProcess.argtypes = (asa, puntero)
        k.QueryFullProcessImageNameW.argtypes = (asa, dword, ctypes.c_wchar_p, puntero)
        a.OpenProcessToken.argtypes = (asa, dword, puntero)
        a.GetTokenInformation.argtypes = (asa, ctypes.c_int, puntero, dword, puntero)
        a.GetSidSubAuthorityCount.argtypes = (puntero,)
        a.GetSidSubAuthorityCount.restype = ctypes.POINTER(ctypes.c_ubyte)
        a.GetSidSubAuthority.argtypes = (puntero, dword)
        a.GetSidSubAuthority.restype = ctypes.POINTER(dword)
        n.NtQueryInformationProcess.argtypes = (asa, ctypes.c_int, puntero, dword, puntero)
        self._hilo.start()
        return self

    def __exit__(self, *_exc) -> None:
        self._fin.set()
        self._hilo.join()
        self._muestrear()
        self._cerrar()

    def _bucle(self) -> None:
        while not self._fin.wait(self.PERIODO):
            self._muestrear()

    def _instantanea(self) -> list[tuple[int, int, str]]:
        filas = []
        h = self._k.CreateToolhelp32Snapshot(2, 0)  # TH32CS_SNAPPROCESS
        try:
            e = _EntradaProceso(dwSize=ctypes.sizeof(_EntradaProceso))
            hay = self._k.Process32FirstW(h, ctypes.byref(e))
            while hay:
                filas.append((e.th32ProcessID, e.th32ParentProcessID, e.szExeFile.lower()))
                hay = self._k.Process32NextW(h, ctypes.byref(e))
        finally:
            self._k.CloseHandle(h)
        return filas

    def _muestrear(self) -> None:
        filas = self._instantanea()
        # ponytail: un ppid rancio que coincida con un descendiente colaría a un ajeno en el árbol; solo
        # importaría si además fuese Chrome, y la ruta de <estado> lo delataría. Comparar fechas si estorba.
        crece = True
        while crece:
            crece = False
            for pid, ppid, _ in filas:
                if ppid in self._arbol and pid not in self._arbol:
                    self._arbol.add(pid)
                    self._asas[pid] = self._k.OpenProcess(0x1000, False, pid) or 0  # QUERY_LIMITED
                    self._errores[pid] = ctypes.get_last_error()
                    crece = True
        ahora = time.monotonic()
        for pid, ppid, imagen in filas:
            if pid not in self._arbol or pid == self.raiz or imagen not in IMAGENES_CHROME:
                continue
            v = self._vistos.setdefault(
                pid,
                {"pid": pid, "ppid": ppid, "tipo": "?", "nivel": -9, "salida": -1, "cmd": "", "ruta": "", "t0": ahora},
            )
            v["vida_ms"] = int((ahora - v["t0"]) * 1000)
            h = self._asas.get(pid)
            if h and v["tipo"] == "?":
                v["ruta"] = self._ruta(h)
                v["cmd"] = self._cmd(h)
                if v["cmd"]:
                    v["tipo"] = tipo_de(v["cmd"])

    def _ruta(self, h: int) -> str:
        n = ctypes.c_ulong(32768)
        b = ctypes.create_unicode_buffer(n.value)
        return b.value if self._k.QueryFullProcessImageNameW(h, 0, b, ctypes.byref(n)) else ""

    def _cmd(self, h: int) -> str:
        """ProcessCommandLineInformation: basta con el permiso limitado, también en un Untrusted."""
        n = ctypes.c_ulong(0)
        self._n.NtQueryInformationProcess(h, 60, None, 0, ctypes.byref(n))
        if not n.value:
            return ""
        b = ctypes.create_string_buffer(n.value)
        if self._n.NtQueryInformationProcess(h, 60, b, n.value, ctypes.byref(n)) != 0:
            return ""
        largo = ctypes.c_ushort.from_buffer(b).value  # UNICODE_STRING: Length, ..., Buffer
        texto = ctypes.c_void_p.from_buffer(b, ctypes.sizeof(ctypes.c_void_p)).value
        return ctypes.wstring_at(texto, largo // 2) if texto else ""

    def _nivel(self, h: int) -> int:
        """-2: no abre el token; -3: no da su integridad. Cualquiera de los dos es fallo."""
        t = ctypes.c_void_p()
        if not self._a.OpenProcessToken(h, 8, ctypes.byref(t)):  # TOKEN_QUERY
            return -2
        try:
            n = ctypes.c_ulong(0)
            self._a.GetTokenInformation(t, 25, None, 0, ctypes.byref(n))  # TokenIntegrityLevel
            b = ctypes.create_string_buffer(n.value)
            if not n.value or not self._a.GetTokenInformation(t, 25, b, n.value, ctypes.byref(n)):
                return -3
            sid = ctypes.c_void_p.from_buffer(b).value
            cuenta = self._a.GetSidSubAuthorityCount(sid).contents.value
            return self._a.GetSidSubAuthority(sid, cuenta - 1).contents.value
        finally:
            self._k.CloseHandle(t)

    def _cerrar(self) -> None:
        for pid, v in self._vistos.items():
            h = self._asas.get(pid)
            if h:
                v["nivel"] = self._nivel(h)
                salida = ctypes.c_ulong(0)
                if self._k.GetExitCodeProcess(h, ctypes.byref(salida)):
                    v["salida"] = salida.value
            else:  # error 87: ya no existía. -4: existe y no se puede abrir, y eso es fallo.
                v["nivel"] = SALIO_ANTES if self._errores.get(pid) == 87 else -4
            v["ajeno"] = bool(v["ruta"]) and not os.path.normcase(v["ruta"]).startswith(self.carpeta)
        for h in self._asas.values():
            if h:
                self._k.CloseHandle(h)

    def procesos(self) -> list[dict]:
        return list(self._vistos.values())

    def renderers(self) -> list[dict]:
        return [p for p in self.procesos() if p["tipo"] == "renderer"]


def tipo_de(cmd: str) -> str:
    if re.search(r"\s--version(\s|$)", cmd):  # el preflight de HyperFrames: no abre nada
        return "version"
    m = re.search(r"--type=([\w-]+)", cmd)
    return m[1] if m else "browser"


def lista_bypass(cmd: str) -> str | None:
    m = re.search(r"--proxy-bypass-list=\S+", cmd)
    return m[0] if m else None


def nombre_nivel(nivel: int) -> str:
    return NOMBRES.get(nivel, f"ilegible ({nivel})")


def fallos_integridad(procesos: list[dict]) -> list[str]:
    """Las reglas de `comprobarProcesos` (sandbox-render.test.ts) sobre lo medido; vacía si se cumple I3."""
    fallos = [f"{p['tipo']}#{p['pid']} no es el navegador fijado: {p['ruta']}" for p in procesos if p.get("ajeno")]
    renderers = [p for p in procesos if p["tipo"] == "renderer"]
    browsers = [p for p in procesos if p["tipo"] == "browser"]
    if not renderers:
        return [*fallos, "No se observó ningún renderer: la prueba de GPU no hizo un render (fallo cerrado)"]
    for r in renderers:
        padre = next((b for b in browsers if b["pid"] == r["ppid"]), None)
        # Solo la sonda de GPU: un browser sin excepción de proxy no carga composición, y su pestaña
        # inicial puede cerrar en Low antes de bajar el token (I3-causa, Q2).
        if r["nivel"] == LOW and r["salida"] == 0 and padre and lista_bypass(padre["cmd"]) == BYPASS:
            print(f"  renderer #{r['pid']} de la sonda salió en Low sin composición")
        elif r["nivel"] not in (UNTRUSTED, SALIO_ANTES):
            fallos.append(f"renderer #{r['pid']} no está en Untrusted: {nombre_nivel(r['nivel'])}")
    if not any(r["nivel"] == UNTRUSTED for r in renderers):
        fallos.append("Ningún renderer medido en Untrusted")
    # La sonda de GPU no carga composición: sin un browser con excepción de su servidor no hubo render real.
    navegaron = [b for b in browsers if lista_bypass(b["cmd"]) != BYPASS]
    if not any(r["ppid"] == b["pid"] and r["nivel"] == UNTRUSTED for b in navegaron for r in renderers):
        fallos.append("Ningún renderer Untrusted cargó la composición: no hubo render real (fallo cerrado)")
    for p in procesos:
        if p["tipo"] == "?" and p["nivel"] not in (UNTRUSTED, SALIO_ANTES) and p["vida_ms"] >= VIDA_MINIMA_MS:
            fallos.append(f"proceso sin identificar #{p['pid']}: {nombre_nivel(p['nivel'])}, {p['vida_ms']} ms")
    if not browsers:
        fallos.append("No se observó ningún proceso browser")
    for b in browsers:
        faltan = [f for f in FLAGS_BROWSER if f not in b["cmd"]]
        lista = lista_bypass(b["cmd"])
        if not lista or not BYPASS_VALIDO.fullmatch(lista):
            faltan.append(f"{BYPASS} (hay {lista})")
        if faltan:
            fallos.append(f"browser #{b['pid']} sin los flags de red: {faltan}")
        if m := FLAGS_PROHIBIDOS.search(b["cmd"]):
            fallos.append(f"browser #{b['pid']} con {m[0]}")
        con_renderer = any(r["ppid"] == b["pid"] and r["nivel"] == UNTRUSTED for r in renderers)
        if not con_renderer and b["vida_ms"] >= VIDA_MINIMA_MS:
            fallos.append(f"browser #{b['pid']} ({b['vida_ms']} ms) sin renderer Untrusted")
    return fallos


def control_vigilante(chrome: str, navegador: Path) -> None:
    """Un Chrome con --no-sandbox bajo el mismo vigilante: si no lo distingue, el smoke no demuestra nada.

    Cuelga de este proceso, no del sidecar: de ahí la raíz. Red cerrada como en el producto y una página
    `data:` (nada que resolver) que garantiza un renderer; un control sin flags ya hizo DNS en W1.3.
    """
    with (
        tempfile.TemporaryDirectory(prefix="smoke-control-", ignore_cleanup_errors=True) as perfil,
        VigilanteIntegridad(navegador, os.getpid()) as v,
    ):
        c = subprocess.Popen(
            [chrome, "--headless", f"--user-data-dir={perfil}", PROXY_NULO, BYPASS, RESOLVER, WEBRTC, QUIC]
            + ["--no-sandbox", "data:text/html,<p>control</p>"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            # Cada proceso de este CfT puede tardar ~2 s en arrancar (I3-causa, Q4).
            t0 = time.time()
            while not v.renderers() and time.time() - t0 < 60:
                time.sleep(0.2)
        finally:
            subprocess.run(["taskkill", "/PID", str(c.pid), "/T", "/F"], capture_output=True, check=False)
            c.wait(timeout=30)
    renderers = v.renderers()
    assert renderers, f"Control: el vigilante no vio el renderer del Chrome con --no-sandbox: {v.procesos()}"
    assert all(r["nivel"] not in (UNTRUSTED, SALIO_ANTES) for r in renderers), f"Control: {renderers}"
    assert any("no está en Untrusted" in f for f in fallos_integridad(v.procesos())), "Control: fallo sin marcar"
    niveles = sorted({nombre_nivel(r["nivel"]) for r in renderers})
    print(f"Control del vigilante OK: con --no-sandbox ve {len(renderers)} renderer(s) en {niveles}")


def comprobar_video(base: str, motor: Path, estado: str, t0: float, sidecar: int) -> None:
    st, cuerpo = get(base, "/video/capacidades", token="malo")
    assert st == 401, f"GET /video/capacidades sin token valido deberia dar 401, dio {st}"
    # Con el estado vacío el motor hace su prueba de GPU (un render corto): puede tardar minutos. El
    # cliente espera más que el servidor (TIMEOUT_CAPACIDADES, 420 s): si el motor se cuelga, se ve
    # el 502 del backend con su mensaje y no un timeout mudo del cliente.
    navegador = Path(estado) / "video" / "navegador"
    with VigilanteIntegridad(navegador, sidecar) as v:
        st, cuerpo = get(base, "/video/capacidades", timeout=480)
    assert st == 200, f"GET /video/capacidades -> {st}: {cuerpo}"
    fallos = fallos_integridad(v.procesos())
    assert not fallos, f"Sandbox del render (I3): {fallos}\n{v.procesos()}"
    for r in v.renderers():
        print(f"  renderer #{r['pid']} nivel={nombre_nivel(r['nivel'])}")
    print(f"Integridad OK en un render real: {len(v.renderers())} renderers de {len(v.procesos())} procesos")
    c = json.loads(cuerpo)
    print(f"  prueba de GPU: {c.get('gpu')}")
    assert c.get("hyperframes") == HYPERFRAMES, f"hyperframes={c.get('hyperframes')!r}, esperado {HYPERFRAMES}"
    assert (c.get("telemetria") or "").startswith("desactivada"), f"telemetria={c.get('telemetria')!r}"
    ffmpeg = c.get("ffmpeg") or ""
    assert ffmpeg and "--enable-libx264" not in ffmpeg, f"ffmpeg={ffmpeg!r}"
    assert FFMPEG in ffmpeg, f"ffmpeg={ffmpeg!r}: no es el ffmpeg LGPL del bundle"
    # El sondeo del render pasa por revisarEncoders en modo integrado: si el ffmpeg trae libx264 o
    # libopenh264, lanza y el motor omite `codificadores` (es lo que rompe importar y renderizar).
    codificadores = c.get("codificadores")
    assert isinstance(codificadores, list), (
        f"codificadores={codificadores!r}: falló el sondeo del render (¿ffmpeg con libopenh264? mira el log del motor)"
    )
    chrome = c.get("chrome") or ""
    carpeta = navegador / CFT_VERSION
    assert chrome.lower().startswith(str(carpeta).lower()), f"chrome={chrome!r}: no es el de {carpeta}"
    manifiesto = json.loads((carpeta / "MANIFIESTO-SHA256.json").read_text(encoding="utf-8"))
    assert len(manifiesto["ficheros"]) == CFT_FICHEROS, f"manifiesto con {len(manifiesto['ficheros'])} ficheros"
    assert not (motor / "browser").exists(), f"{motor / 'browser'} existe: el bundle no debe llevar Chrome (I12)"
    print(f"GET /video/capacidades OK en {time.time() - t0:.1f} s")
    print(f"  hyperframes {c['hyperframes']} · telemetria {c['telemetria']}")
    print(f"  {ffmpeg}")
    print(f"  codificadores {[x['codificador'] for x in codificadores] or 'ninguno'}")
    print(f"  chrome {chrome}")
    control_vigilante(chrome, navegador)


def comprobar_dist_alterado(base: str, estado: str, sidecar: int, fichero: str) -> None:
    """Con un byte cambiado, /video/capacidades lo cuenta y la CLI no llega a lanzarse (R0 M12)."""
    with VigilanteIntegridad(Path(estado) / "video" / "navegador", sidecar) as v:
        st, cuerpo = get(base, "/video/capacidades", timeout=480)
    assert st == 200, f"GET /video/capacidades con el dist alterado -> {st}: {cuerpo}"
    gpu = json.loads(cuerpo).get("gpu") or {}
    detalle = gpu.get("detalle") or ""
    assert gpu.get("webgpu") is False and fichero in detalle and "reinstala" in detalle, f"gpu={gpu}"
    assert not v.procesos(), f"Con el dist alterado se lanzó Chrome: {v.procesos()}"
    print(f"Negativo del dist OK: {detalle}")


def negativo_dist(exe: Path, motor: Path, origen: str) -> None:
    """Repite contra una copia del motor con un byte cambiado; el original no se toca."""
    fichero = "dist/chunk-PBNWRWKA.js"
    with tempfile.TemporaryDirectory(prefix="smoke-video-engine-", ignore_cleanup_errors=True) as tmp:
        copia = Path(tmp) / "video-engine"
        shutil.copytree(origen, copia)
        f = copia / "app" / "node_modules" / "hyperframes" / fichero
        datos = bytearray(f.read_bytes())
        datos[-1] ^= 1
        f.write_bytes(datos)
        try:
            comprobar_parche_bundle(copia)
        except AssertionError as e:
            assert fichero in str(e), e
        else:
            raise AssertionError("comprobar_parche_bundle no detectó el byte cambiado")
        creado: list[str] = []
        try:
            preparar_motor(motor, str(copia), creado)
            arrancar_y_comprobar(exe, motor, None, False, dist_alterado=fichero)
        finally:
            retirar_motor(motor, creado)


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
        codigo = arrancar_y_comprobar(exe, motor if hay_motor else None, args.cft_zip, args.cft_descargar)
    finally:
        retirar_motor(motor, creado)
    if args.video_engine:
        negativo_dist(exe, motor, args.video_engine)
    return codigo


def arrancar_y_comprobar(
    exe: Path, motor: Path | None, cft_zip: str | None, cft_descargar: bool, dist_alterado: str | None = None
) -> int:
    if motor is not None and dist_alterado is None:
        comprobar_parche_bundle(motor)
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
        **VARIABLES_DE_PRUEBA,  # el sidecar congelado no las pasa al motor (comprobar_motor_sin_pruebas)
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

        comprobar_docs_ausentes(base)
        comprobar_navegador(base, cft_zip, cft_descargar)
        if motor is None:
            # Release sin VIDEO_ENGINE: el módulo no instalado es un 503 legible, no un 500.
            st, cuerpo = get(base, "/video/capacidades")
            assert st == 503 and "no está instalado" in json.loads(cuerpo)["detail"], (
                f"GET /video/capacidades sin motor -> {st}: {cuerpo}"
            )
            print("Sin video-engine junto al binario: GET /video/capacidades da 503 (módulo no instalado)")
        elif dist_alterado:
            comprobar_dist_alterado(base, estado, proc.pid, dist_alterado)
        else:
            comprobar_video(base, motor, estado, t0, proc.pid)
            comprobar_preview(base, motor)
            comprobar_motor_sin_pruebas(proc.pid)
        if motor is None:
            comprobar_preview(base, None)
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
