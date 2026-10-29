"""Conversaciones del chat guardadas en disco (SEO-100): sobreviven a cerrar la app.

Un JSON por conversación en `<STATE_DIR>/conversaciones/`, con lo que hace falta para seguirla
(`messages`, el historial que recibe el modelo) y para volver a pintarla (`turnos`: el texto que
escribió el usuario y los eventos SSE de la respuesta, que la UI reproduce con su reducer). Se
escribe en un temporal y se renombra, para que un cierre a mitad no deje un fichero roto.

Los ficheros viven en el perfil del usuario de Windows, como el resto del estado del sidecar:
contienen lo hablado con el agente y datos del canal, pero ningún secreto (la clave de Anthropic y
los tokens de Google van en el almacén de credenciales).
"""

import json
import logging
import os
import re
from pathlib import Path

log = logging.getLogger(__name__)

# El id llega en la URL: solo se acepta el alfabeto de secrets.token_urlsafe, nunca una ruta.
ID_VALIDO = re.compile(r"^[A-Za-z0-9_-]{6,64}$")


def titulo_de(texto: str) -> str:
    """Primeras palabras del primer mensaje (misma regla que tituloDe en la UI)."""
    palabras = " ".join(texto.split()[:6])
    return palabras[:39] + "…" if len(palabras) > 40 else palabras


def compactar(eventos: list[dict]) -> list[dict]:
    """Une los deltas de texto seguidos: un turno largo son miles de eventos `text`."""
    salida: list[dict] = []
    for ev in eventos:
        if ev.get("type") == "text" and salida and salida[-1].get("type") == "text":
            salida[-1] = {"type": "text", "delta": salida[-1]["delta"] + ev["delta"]}
        else:
            salida.append(ev)
    return salida


class Almacen:
    def __init__(self, directorio: str | Path):
        self.dir = Path(directorio)

    def _ruta(self, conv_id: str) -> Path | None:
        return self.dir / f"{conv_id}.json" if ID_VALIDO.match(conv_id) else None

    def guardar(self, datos: dict) -> None:
        ruta = self._ruta(datos["id"])
        if ruta is None:
            raise ValueError(f"id de conversación no válido: {datos['id']!r}")
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = ruta.with_suffix(".tmp")
        tmp.write_text(json.dumps(datos, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, ruta)

    def cargar(self, conv_id: str) -> dict | None:
        ruta = self._ruta(conv_id)
        if ruta is None or not ruta.is_file():
            return None
        try:
            return json.loads(ruta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            log.warning("Conversación ilegible, se ignora: %s", ruta.name)
            return None

    def listar(self) -> list[dict]:
        """Resumen de cada conversación (sin el historial), de la más antigua a la más reciente."""
        if not self.dir.is_dir():
            return []
        resumenes = []
        for ruta in self.dir.glob("*.json"):
            datos = self.cargar(ruta.stem)
            if datos:
                resumenes.append({k: datos.get(k) for k in ("id", "titulo", "perfil", "creada", "actualizada")})
        return sorted(resumenes, key=lambda r: r["creada"] or 0)

    def borrar(self, conv_id: str) -> bool:
        ruta = self._ruta(conv_id)
        if ruta is None or not ruta.is_file():
            return False
        ruta.unlink()
        return True
