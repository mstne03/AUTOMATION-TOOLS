"""Carpetas desde las que las tools pueden leer ficheros del disco.

Las rutas las decide el modelo, y la salida de un modelo es entrada no confiable:
sin una lista blanca, `youtube_upload_video` podria subir al canal cualquier
fichero accesible del equipo. Todas las tools que leen ficheros (subida,
miniatura, transcripcion local) pasan por `resolve_allowed`.

Configuracion, con el separador de rutas del sistema (`;` en Windows):

    YOUTUBE_MCP_ALLOWED_DIRS = C:\\Videos\\Smooth=en;C:\\Videos\\Candisito=es;D:\\Clips

Cada entrada es `carpeta[=idioma]`. El idioma es opcional y lo usa
`transcribe_local` como idioma por defecto de los ficheros de esa carpeta.
"""

import os
from pathlib import Path

ENV_VAR = "YOUTUBE_MCP_ALLOWED_DIRS"


class AccessDeniedError(Exception):
    """Ruta fuera de las carpetas permitidas, o lista blanca sin configurar."""


def allowed_dirs() -> dict[Path, str | None]:
    """Carpeta permitida (resuelta) -> idioma por defecto o None."""
    carpetas: dict[Path, str | None] = {}
    for entrada in os.environ.get(ENV_VAR, "").split(os.pathsep):
        entrada = entrada.strip().strip('"').strip("'")
        if not entrada:
            continue
        carpeta, _, idioma = entrada.partition("=")
        carpetas[Path(carpeta.strip()).expanduser().resolve()] = idioma.strip().lower() or None
    return carpetas


def resolve_allowed(file: str) -> tuple[Path, str | None]:
    """Ruta absoluta o nombre de fichero -> (ruta real, idioma por defecto de su carpeta).

    Un nombre sin carpeta ("video137" o "video137.mp4") se busca en cada carpeta
    permitida, probando tambien con la extension .mp4. Las rutas se resuelven
    (`resolve()` sigue enlaces y `..`) antes de comprobar que caen dentro de una
    carpeta permitida, asi que no se puede escapar con `..`.
    """
    carpetas = allowed_dirs()
    if not carpetas:
        raise AccessDeniedError(
            f"No allowed folders configured. Set {ENV_VAR} to the folders this server "
            "may read files from, e.g. C:\\Videos=es;D:\\Clips."
        )

    texto = (file or "").strip().strip('"').strip("'")
    if not texto:
        raise AccessDeniedError("No file given. Pass a file name or an absolute path.")

    candidata = Path(texto)
    if not candidata.is_absolute():
        if candidata.parent != Path("."):
            raise AccessDeniedError(
                f"'{texto}' is a relative path. Pass a bare file name (searched in the "
                "allowed folders) or an absolute path."
            )
        candidata = _buscar_nombre(candidata.name, carpetas)
        if candidata is None:
            raise AccessDeniedError(
                f"File not found: '{texto}' is not in any allowed folder "
                f"({', '.join(str(c) for c in carpetas)})."
            )

    ruta = candidata.resolve()
    carpeta = _carpeta_de(ruta, carpetas)
    if carpeta is None:
        raise AccessDeniedError(
            f"Access denied: '{ruta}' is outside the allowed folders "
            f"({', '.join(str(c) for c in carpetas)})."
        )
    if not ruta.is_file():
        raise AccessDeniedError(f"File not found: {ruta}")
    return ruta, carpetas[carpeta]


def _buscar_nombre(nombre: str, carpetas: dict[Path, str | None]) -> Path | None:
    for carpeta in carpetas:
        for intento in (nombre, f"{nombre}.mp4"):
            ruta = carpeta / intento
            if ruta.is_file():
                return ruta
    return None


def _carpeta_de(ruta: Path, carpetas: dict[Path, str | None]) -> Path | None:
    destino = os.path.normcase(str(ruta))
    for carpeta in carpetas:
        base = os.path.normcase(str(carpeta))
        try:
            if os.path.commonpath([destino, base]) == base:
                return carpeta
        except ValueError:  # distinta unidad
            continue
    return None
