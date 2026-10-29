"""Navegador del render (Chrome for Testing) descargado en el primer uso (SEO-108; spec D10, I4, I6, I11, I14).

El instalador no lleva el navegador. Cuando el usuario lo pide (nunca el modelo: no hay tool ni
`JOB_KINDS`), el backend baja el zip de la URL fijada en `config`, comprueba tamaño y SHA-256 al
vuelo y otra vez desde el mismo handle **antes** de abrirlo como zip, valida todas las entradas
antes de escribir nada, extrae en una carpeta nueva y vacía, genera el manifiesto SHA-256 de cada
fichero (que tiene que casar con `config.NAVEGADOR_MANIFIESTO_SHA256`), lo vuelve a verificar
desde disco y lo publica por renombrado atómico en `<estado>/video/navegador/<versión>/`. Nunca
se usa una extracción a medias.

Ruta fija y sin alternativas: ni el entorno ni un argumento cambian qué navegador usa el motor.
`verificar` comprueba el árbol contra el manifiesto anclado; el motor (W1.6) lo repite antes de
cada invocación de HyperFrames con `HYPERFRAMES_BROWSER_PATH` y `VIDEO_NAVEGADOR_MANIFIESTO`.

Todo lee `config.X` en el momento de la llamada (los tests parchean `config`).

Desarrollo y smoke test, sin red: `python -m app_backend.navegador --zip RUTA` instala desde un zip
local por el mismo camino y con el mismo SHA-256 fijado (el binario congelado no ejecuta `-m`).
"""

import argparse
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import stat
import sys
import tempfile
import threading
import time
import zipfile  # siempre por el módulo: los tests espían `navegador.zipfile.ZipFile`
import zlib
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

import httpx

from app_backend import config
from app_backend.kb_update import _replace_retry

log = logging.getLogger("app_backend.navegador")

MENSAJE_SIN_RED = (
    "No se pudo descargar el navegador del render: no hay conexión con storage.googleapis.com. "
    "Comprueba tu conexión y vuelve a intentarlo."
)
# Con un proxy corporativo que inspecciona TLS también sale este: visible, aceptado (no se relaja).
MENSAJE_TLS = "No se pudo verificar el certificado de storage.googleapis.com: no se ha descargado nada."
MENSAJE_HTTP = "El servidor de descarga respondió {codigo}: no se ha instalado nada. Vuelve a intentarlo más tarde."
MENSAJE_GRANDE = "La descarga del navegador supera el tamaño esperado: se ha cancelado y no se ha instalado nada."
MENSAJE_HASH = (
    "La descarga del navegador no coincide con la versión esperada (SHA-256): no se ha instalado nada. "
    "Vuelve a intentarlo."
)
MENSAJE_ENTRADA = "El archivo del navegador contiene una entrada no permitida ({nombre}): no se ha instalado nada."
MENSAJE_TOPES = (
    "El archivo del navegador supera el tamaño o el número de ficheros esperados: no se ha instalado nada."
)
MENSAJE_CORRUPTO = "El navegador del render no supera la verificación ({detalle}): vuelve a descargarlo."
MENSAJE_ESPACIO = "No hay espacio suficiente para el navegador del render (hacen falta {mb} MB libres)."
MENSAJE_DISCO = "No se pudo instalar el navegador del render ({detalle}): no se ha instalado nada. Vuelve a intentarlo."
MENSAJE_ENLACE = "La carpeta del navegador es un enlace o punto de reanálisis ({ruta}): no se usa."
MENSAJE_CODIFICACION = (
    "El servidor de descarga respondió con una codificación inesperada ({codificacion}): "
    "no se ha instalado nada."
)
MENSAJE_PLAZO = (
    "La descarga del navegador ha tardado más de 30 minutos: se ha cancelado y no se ha instalado nada. "
    "Vuelve a intentarlo."
)
MENSAJE_OCUPADO = "Otra instancia de SEO Studio está instalando el navegador: espera a que termine."

BLOQUE = 1 << 20
MAX_MANIFIESTO = 1 << 20
BLOQUEO = ".bloqueo"
_RAIZ = "chrome-headless-shell-win64"
_COMPONENTE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._-]{0,127}")
_RESERVADOS = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(10)), *(f"lpt{i}" for i in range(10))}
_HEX64 = re.compile(r"[0-9a-f]{64}")


class NavegadorError(Exception):
    """Error legible para la UI (texto tal cual)."""


# ----------------------------------------------------------------------------- utilidades


def nombre_valido(nombre: str) -> bool:
    """Lista blanca de nombres de entrada (con `/`): excluye por construcción `..`, `.`, `\\`, rutas
    absolutas, letras de unidad, `:` (flujos alternativos de NTFS), espacios y puntos finales,
    nombres de dispositivo y caracteres de control."""
    if not isinstance(nombre, str) or len(nombre) > 200:
        return False
    partes = nombre.removesuffix("/").split("/")
    if partes[0] != _RAIZ or not 2 <= len(partes) <= 8:
        return False
    return all(
        _COMPONENTE.fullmatch(p) and not p.endswith(".") and p.split(".")[0].lower() not in _RESERVADOS
        for p in partes
    )


def es_enlace(p: Path) -> bool:
    """Symlink, junction o cualquier otro punto de reanálisis (montajes, marcadores de la nube)."""
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(st.st_mode) or bool(getattr(st, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _corto(nombre: str) -> str:
    r = repr(nombre)
    return r if len(r) <= 120 else r[:117] + "..."


def _sha256_fichero(ruta: Path) -> str:
    h = hashlib.sha256()
    with open(ruta, "rb") as f:
        while trozo := f.read(BLOQUE):
            h.update(trozo)
    return h.hexdigest()


def serializar_manifiesto(ficheros: dict[str, str]) -> bytes:
    """Serialización canónica (la que ancla `config.NAVEGADOR_MANIFIESTO_SHA256`)."""
    obj = {"version": config.NAVEGADOR_VERSION, "ficheros": ficheros}
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def _borrar(ruta: Path) -> None:
    """Borra `ruta` sin seguir nunca un enlace: de un enlace (o junction) se quita solo el enlace."""
    try:
        st = os.lstat(ruta)
    except FileNotFoundError:
        return
    if es_enlace(ruta):
        # Se quita solo el enlace: de directorio (junction, symlink de carpeta) con rmdir, de
        # fichero con unlink. Ninguno de los dos sigue el enlace.
        atributos = getattr(st, "st_file_attributes", 0)
        if stat.S_ISDIR(st.st_mode) or atributos & stat.FILE_ATTRIBUTE_DIRECTORY:
            os.rmdir(ruta)
        else:
            os.unlink(ruta)
        return
    if stat.S_ISDIR(st.st_mode):
        with os.scandir(ruta) as it:
            hijos = [Path(e.path) for e in it]
        for h in hijos:
            _borrar(h)
        os.rmdir(ruta)
        return
    try:
        os.unlink(ruta)
    except PermissionError:
        os.chmod(ruta, stat.S_IWRITE)  # solo lectura en Windows
        os.unlink(ruta)


# ----------------------------------------------------------------------------- extracción


def extraer(zf: zipfile.ZipFile, destino: Path) -> dict[str, str]:
    """Extrae `zf` en `destino` (existente y vacío) y devuelve `{ruta relativa con /: sha256}`.

    Valida todas las entradas antes de escribir nada; cuenta los bytes reales, no los de la cabecera.
    """
    destino = Path(destino)
    if not destino.is_dir() or es_enlace(destino) or any(destino.iterdir()):
        raise NavegadorError(MENSAJE_DISCO.format(detalle="la carpeta de extracción no es nueva y vacía"))
    infos = zf.infolist()
    if len(infos) > config.NAVEGADOR_MAX_FICHEROS or sum(i.file_size for i in infos) > config.NAVEGADOR_MAX_EXTRAIDO:
        raise NavegadorError(MENSAJE_TOPES)
    vistos: set[str] = set()
    for i in infos:
        no = NavegadorError(MENSAJE_ENTRADA.format(nombre=_corto(i.filename)))
        clave = i.filename.rstrip("/").casefold()
        if not nombre_valido(i.filename) or clave in vistos:
            raise no
        vistos.add(clave)
        if i.flag_bits & 0x1 or i.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise no
        # Enlaces y ficheros especiales de Unix (zipfile nunca los crea, pero se rechazan explícitamente).
        if i.create_system == 3 and stat.S_IFMT(i.external_attr >> 16) not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise no

    raiz = os.path.abspath(destino)
    ficheros: dict[str, str] = {}
    total = 0
    for i in infos:
        ruta = Path(raiz, *i.filename.rstrip("/").split("/"))
        if os.path.commonpath([raiz, os.path.abspath(ruta)]) != raiz:
            raise NavegadorError(MENSAJE_ENTRADA.format(nombre=_corto(i.filename)))
        if i.is_dir():
            ruta.mkdir(parents=True, exist_ok=True)
            continue
        ruta.parent.mkdir(parents=True, exist_ok=True)
        h = hashlib.sha256()
        n = 0
        try:
            with zf.open(i) as origen, open(ruta, "xb") as f:
                while trozo := origen.read(BLOQUE):
                    n += len(trozo)
                    total += len(trozo)
                    if n > i.file_size or total > config.NAVEGADOR_MAX_EXTRAIDO:
                        raise NavegadorError(MENSAJE_TOPES)
                    h.update(trozo)
                    f.write(trozo)
        except (zipfile.BadZipFile, zlib.error, EOFError):  # CRC o tamaño que no casan con la cabecera
            raise NavegadorError(MENSAJE_ENTRADA.format(nombre=_corto(i.filename))) from None
        if n != i.file_size:
            raise NavegadorError(MENSAJE_ENTRADA.format(nombre=_corto(i.filename)))
        ficheros[i.filename] = h.hexdigest()
    return ficheros


# ----------------------------------------------------------------------------- verificación


def _corrupto(detalle: str) -> NavegadorError:
    return NavegadorError(MENSAJE_CORRUPTO.format(detalle=detalle))


def _arbol(carpeta: Path) -> set[str]:
    """Rutas relativas (con /) de todos los ficheros bajo `carpeta`, sin seguir enlaces."""
    rutas: set[str] = set()
    pendientes = [(carpeta, "")]
    while pendientes:
        d, prefijo = pendientes.pop()
        with os.scandir(d) as it:
            for e in it:
                rel = prefijo + e.name
                p = Path(e.path)
                if es_enlace(p):
                    raise _corrupto(f"{rel} es un enlace")
                st = os.lstat(p)
                if stat.S_ISDIR(st.st_mode):
                    pendientes.append((p, rel + "/"))
                elif stat.S_ISREG(st.st_mode):
                    if st.st_nlink != 1:  # hardlink: otro nombre fuera puede cambiar el fichero (I6)
                        raise _corrupto(f"{rel} tiene otro enlace duro")
                    rutas.add(rel)
                else:
                    raise _corrupto(f"{rel} no es un fichero normal")
    return rutas


def verificar(carpeta: Path) -> Path:
    """Comprueba `carpeta` contra su manifiesto anclado y devuelve la ruta del exe.

    `NavegadorError(MENSAJE_CORRUPTO…)` si sobra, falta o cambia cualquier fichero, si hay enlaces
    o si el manifiesto no es el de la versión fijada.
    """
    carpeta = Path(carpeta)
    manifiesto = carpeta / config.NAVEGADOR_MANIFIESTO
    if es_enlace(carpeta) or es_enlace(manifiesto):
        raise _corrupto("la carpeta o el manifiesto es un enlace")
    try:
        with open(manifiesto, "rb") as f:
            datos = f.read(MAX_MANIFIESTO + 1)
    except OSError:
        raise _corrupto("falta el manifiesto") from None
    if len(datos) > MAX_MANIFIESTO:
        raise _corrupto("manifiesto demasiado grande")
    # Antes de confiar en el contenido: los bytes tienen que ser los del manifiesto anclado.
    if hashlib.sha256(datos).hexdigest() != config.NAVEGADOR_MANIFIESTO_SHA256:
        raise _corrupto("el manifiesto no es el de la versión fijada")
    try:
        obj = json.loads(datos)
    except ValueError:
        raise _corrupto("manifiesto ilegible") from None
    if not isinstance(obj, dict) or set(obj) != {"version", "ficheros"} or not isinstance(obj["ficheros"], dict):
        raise _corrupto("manifiesto con otra forma")
    if obj["version"] != config.NAVEGADOR_VERSION:
        raise _corrupto(f"versión {obj['version']!r}, se esperaba {config.NAVEGADOR_VERSION}")
    esperados: dict[str, str] = obj["ficheros"]
    for nombre, valor in esperados.items():
        if not nombre_valido(nombre) or nombre.endswith("/") or not (isinstance(valor, str) and _HEX64.fullmatch(valor)):
            raise _corrupto(f"entrada no permitida {_corto(nombre)}")
    if config.NAVEGADOR_EXE not in esperados:
        raise _corrupto("el manifiesto no incluye el ejecutable")
    reales = _arbol(carpeta) - {config.NAVEGADOR_MANIFIESTO}
    if sobran := sorted(reales - set(esperados)):
        raise _corrupto(f"sobra {_corto(sobran[0])}")
    if faltan := sorted(set(esperados) - reales):
        raise _corrupto(f"falta {_corto(faltan[0])}")
    for nombre, valor in sorted(esperados.items()):
        if _sha256_fichero(carpeta.joinpath(*nombre.split("/"))) != valor:
            raise _corrupto(f"{nombre} ha cambiado")
    return carpeta.joinpath(*config.NAVEGADOR_EXE.split("/"))


def _ancestros() -> tuple[Path, ...]:
    # Los ancestros por encima del directorio de estado (%LOCALAPPDATA%…) se consideran confiables.
    return (config.STATE_DIR, config.STATE_DIR / "video", config.NAVEGADOR_DIR)


def comprobar_ancestros() -> None:
    """`NavegadorError(MENSAJE_ENLACE)` si `<estado>`, `<estado>/video` o `NAVEGADOR_DIR` es un enlace."""
    for p in _ancestros():
        if es_enlace(p):
            raise NavegadorError(MENSAJE_ENLACE.format(ruta=p))


def instalado() -> tuple[Path, Path] | None:
    """`(exe, manifiesto)` de la versión fijada si está publicada en la ruta fija; **sin hashear**."""
    carpeta = config.NAVEGADOR_DIR / config.NAVEGADOR_VERSION
    if any(es_enlace(p) for p in (*_ancestros(), carpeta)):
        return None
    exe = carpeta.joinpath(*config.NAVEGADOR_EXE.split("/"))
    manifiesto = carpeta / config.NAVEGADOR_MANIFIESTO
    if carpeta.is_dir() and exe.is_file() and manifiesto.is_file():
        return exe, manifiesto
    return None


# ----------------------------------------------------------------------------- instalación


def _preparar_base() -> Path:
    """Crea `NAVEGADOR_DIR` comprobando que ni él ni sus ancestros son enlaces, y el espacio libre."""
    comprobar_ancestros()
    base = config.NAVEGADOR_DIR
    try:
        base.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise NavegadorError(MENSAJE_DISCO.format(detalle=e.strerror or type(e).__name__)) from None
    comprobar_ancestros()  # otra vez: lo recién creado podría haberse cambiado por un enlace
    necesario = (config.NAVEGADOR_MAX_DESCARGA + config.NAVEGADOR_MAX_EXTRAIDO) * 11 // 10
    if shutil.disk_usage(base).free < necesario:
        raise NavegadorError(MENSAJE_ESPACIO.format(mb=necesario // 1_000_000 + 1))
    return base


@contextmanager
def _candado() -> Iterator[None]:
    """Candado entre procesos en `NAVEGADOR_DIR/.bloqueo` (dos instancias de la app, por ejemplo)."""
    ruta = config.NAVEGADOR_DIR / BLOQUEO
    if es_enlace(ruta):
        raise NavegadorError(MENSAJE_ENLACE.format(ruta=ruta))
    try:
        fd = os.open(ruta, os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o600)
    except OSError as e:
        raise NavegadorError(MENSAJE_DISCO.format(detalle=e.strerror or type(e).__name__)) from None
    try:
        try:
            if sys.platform == "win32":
                import msvcrt

                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise NavegadorError(MENSAJE_OCUPADO) from None
        try:
            yield
        finally:
            if sys.platform == "win32":
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    finally:
        os.close(fd)


def _limpiar(base: Path) -> None:
    """Borra todo lo de `base` salvo la versión actual (si no es un enlace) y el candado."""
    with os.scandir(base) as it:
        nombres = [e.name for e in it]
    for nombre in nombres:
        p = base / nombre
        if nombre == BLOQUEO or (nombre == config.NAVEGADOR_VERSION and not es_enlace(p)):
            continue
        _borrar(p)


def limpiar_restos() -> None:
    """Al arrancar: borra descargas, extracciones y versiones viejas. Si otra instancia tiene el
    candado, no toca nada."""
    base = config.NAVEGADOR_DIR
    if any(es_enlace(p) for p in _ancestros()) or not base.is_dir():
        return
    try:
        with _candado():
            _limpiar(base)
    except NavegadorError as e:
        log.info("Navegador: no se limpian restos (%s)", e)


def _instalar(zip_path: Path, al_cambiar_fase: Callable[[str], None]) -> Path:
    """Instala desde `zip_path` con el candado ya tomado y la base preparada."""
    base = config.NAVEGADOR_DIR
    final = base / config.NAVEGADOR_VERSION
    tmp: Path | None = None
    try:
        al_cambiar_fase("verificando")
        with open(zip_path, "rb") as f:
            if os.fstat(f.fileno()).st_size > config.NAVEGADOR_MAX_DESCARGA:
                raise NavegadorError(MENSAJE_GRANDE)
            h = hashlib.sha256()
            while trozo := f.read(BLOQUE):
                h.update(trozo)
            # Se abre como zip el mismo handle que se ha hasheado, y solo si casa.
            if h.hexdigest() != config.NAVEGADOR_SHA256:
                raise NavegadorError(MENSAJE_HASH)
            f.seek(0)
            al_cambiar_fase("extrayendo")
            tmp = Path(tempfile.mkdtemp(prefix=".extraccion-", dir=base))
            try:
                with zipfile.ZipFile(f) as zf:
                    ficheros = extraer(zf, tmp)
            except zipfile.BadZipFile:
                raise _corrupto("zip ilegible") from None
        datos = serializar_manifiesto(ficheros)
        if hashlib.sha256(datos).hexdigest() != config.NAVEGADOR_MANIFIESTO_SHA256:
            raise _corrupto("el manifiesto generado no es el de la versión fijada")
        with open(tmp / config.NAVEGADOR_MANIFIESTO, "xb") as m:
            m.write(datos)
        verificar(tmp)  # desde disco: un antivirus puede haber quitado una .dll al extraer
        viejo = None
        if os.path.lexists(final):
            viejo = base / f".viejo-{secrets.token_hex(4)}"
            _replace_retry(final, viejo)
        try:
            _replace_retry(tmp, final)
        except OSError:
            if viejo is not None:
                _replace_retry(viejo, final)
            raise
        tmp = None
        try:
            exe = verificar(final)
        except NavegadorError:
            _borrar(final)
            raise
        _limpiar(base)
        return exe
    except OSError as e:
        raise NavegadorError(MENSAJE_DISCO.format(detalle=e.strerror or type(e).__name__)) from None
    finally:
        if tmp is not None:
            _borrar(tmp)


def instalar_desde_zip(zip_path: Path, al_cambiar_fase: Callable[[str], None] = lambda f: None) -> Path:
    """Verifica, extrae y publica el zip en la ruta fija; devuelve el exe publicado."""
    _preparar_base()
    with _candado():
        return _instalar(Path(zip_path), al_cambiar_fase)


# ----------------------------------------------------------------------------- descarga

# Guard de la constante: la URL fijada tiene que ser HTTPS de storage.googleapis.com (solo los tests
# la cambian). Ninguna redirección se sigue (ni siquiera al mismo host): no hace falta ninguna.
PREFIJO_URL = "https://storage.googleapis.com/"
PLAZO_DESCARGA = 30 * 60  # segundos; además de los timeouts de conexión y lectura por trozo


def _cliente(transporte: httpx.BaseTransport | None) -> httpx.Client:
    # Verificación TLS por defecto (certifi). `trust_env` por defecto: proxies del sistema; la
    # integridad la da el SHA-256, no el canal.
    return httpx.Client(transport=transporte, follow_redirects=False, timeout=httpx.Timeout(30.0, read=60.0))


def descargar(cliente: httpx.Client, al_avanzar: Callable[[int], None]) -> Path:
    """Baja el zip fijado a `NAVEGADOR_DIR/.descarga-*.zip` y lo devuelve ya comprobado (tamaño y
    SHA-256 al vuelo). Quien llama lo borra. En cualquier fallo no queda nada."""
    url = config.NAVEGADOR_URL
    if not url.startswith(PREFIJO_URL):
        raise NavegadorError(f"URL del navegador no permitida: {_corto(url)}")
    fd, nombre = tempfile.mkstemp(prefix=".descarga-", suffix=".zip", dir=config.NAVEGADOR_DIR)
    ruta = Path(nombre)
    try:
        h = hashlib.sha256()
        inicio = time.monotonic()
        # identity + iter_raw: se hashea exactamente lo que llega por la red, sin que httpx
        # descomprima nada (una bomba gzip no pasa del tope porque no se descomprime).
        cabeceras = {"Accept-Encoding": "identity"}
        with os.fdopen(fd, "wb") as f, cliente.stream("GET", url, headers=cabeceras) as r:
            if r.status_code != 200:
                raise NavegadorError(MENSAJE_HTTP.format(codigo=r.status_code))
            codificacion = r.headers.get("content-encoding", "identity").strip().lower()
            if codificacion != "identity":
                raise NavegadorError(MENSAJE_CODIFICACION.format(codificacion=_corto(codificacion)))
            try:
                anunciado = int(r.headers.get("content-length", "0"))
            except ValueError:
                anunciado = config.NAVEGADOR_MAX_DESCARGA + 1
            if anunciado > config.NAVEGADOR_MAX_DESCARGA:
                raise NavegadorError(MENSAJE_GRANDE)
            n = 0
            for trozo in r.iter_raw():  # según llegan: el progreso avanza con la red
                if time.monotonic() - inicio > PLAZO_DESCARGA:
                    raise NavegadorError(MENSAJE_PLAZO)
                n += len(trozo)
                if n > config.NAVEGADOR_MAX_DESCARGA:
                    raise NavegadorError(MENSAJE_GRANDE)
                h.update(trozo)
                f.write(trozo)
                al_avanzar(n)
        if h.hexdigest() != config.NAVEGADOR_SHA256:
            raise NavegadorError(MENSAJE_HASH)
        return ruta
    except httpx.TransportError as e:
        _borrar(ruta)
        raise NavegadorError(MENSAJE_TLS if "CERTIFICATE_VERIFY_FAILED" in str(e) else MENSAJE_SIN_RED) from None
    except OSError as e:
        _borrar(ruta)
        raise NavegadorError(MENSAJE_DISCO.format(detalle=e.strerror or type(e).__name__)) from None
    except BaseException:
        _borrar(ruta)
        raise


ACTIVAS = ("descargando", "verificando", "extrayendo")


class Descargador:
    """Estado en memoria del «job» de descarga (base de `GET/POST /video/navegador`).

    `reservar` y `ejecutar` van por separado para que la ruta responda 409 en el acto; `ejecutar`
    es bloqueante (para `asyncio.to_thread`). Sin reintentos automáticos: los decide el usuario.
    """

    def __init__(self, transporte: httpx.BaseTransport | None = None) -> None:
        self._transporte = transporte
        self._lock = threading.Lock()
        self._fase = "listo" if instalado() else "ausente"
        self._descargado = 0
        self._error: str | None = None

    def estado(self) -> dict:
        with self._lock:
            return {
                "version": config.NAVEGADOR_VERSION,
                "tamano": config.NAVEGADOR_TAMANO,
                "estado": self._fase,
                "descargado": self._descargado,
                "error": self._error,
            }

    def reservar(self) -> bool:
        with self._lock:
            if self._fase in ACTIVAS:
                return False
            self._fase, self._descargado, self._error = "descargando", 0, None
            return True

    def _avance(self, n: int) -> None:
        with self._lock:
            self._descargado = n

    def _cambiar_fase(self, fase: str) -> None:
        with self._lock:
            self._fase = fase

    def _fin(self, fase: str, error: str | None = None) -> None:
        with self._lock:
            self._fase, self._error = fase, error

    def ejecutar(self) -> None:
        try:
            _preparar_base()
            with _candado():
                carpeta = config.NAVEGADOR_DIR / config.NAVEGADOR_VERSION
                if instalado():
                    try:
                        verificar(carpeta)
                        self._fin("listo")
                        return
                    except NavegadorError as e:
                        log.warning("Navegador instalado que no verifica, se descarga de nuevo: %s", e)
                with _cliente(self._transporte) as cliente:
                    zip_path = descargar(cliente, self._avance)
                try:
                    _instalar(zip_path, self._cambiar_fase)
                finally:
                    _borrar(zip_path)
            self._fin("listo")
        except NavegadorError as e:
            self._fin("error", str(e))
        except Exception as e:  # nunca un 500 mudo: error visible y reintentable
            log.exception("Error inesperado al instalar el navegador")
            self._fin("error", f"Error inesperado al instalar el navegador: {type(e).__name__}")


# ----------------------------------------------------------------------------- __main__


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m app_backend.navegador", description=__doc__.splitlines()[0])
    ap.add_argument("--zip", required=True, type=Path, help="zip de chrome-headless-shell con el SHA-256 fijado")
    args = ap.parse_args(argv)
    try:
        exe = instalar_desde_zip(args.zip)
    except NavegadorError as e:
        print(e, file=sys.stderr)
        return 1
    print(exe)
    return 0


if __name__ == "__main__":
    sys.exit(main())
