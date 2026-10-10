"""Registro de tools: las funciones de ambos repos con riesgo, cuota y esquema estricto.

Las tools ya estan registradas en los `MCPServer` de cada repo; de ahi salen nombre,
descripcion, esquema y funcion. Aqui solo se anade lo que el agente necesita:

- `risk`: read (se ejecuta sin preguntar), write (gate de aprobacion) o
  destructive (aprobacion repitiendo el ID del video).
- `quota`: cubo y coste de la YouTube Data API, para mostrarlo en la propuesta.
- `job_kind`: las tools largas (subida, transcripcion) se ejecutan en la cola de jobs.
- esquema con `strict: true`: additionalProperties=false y todos los campos
  requeridos; los opcionales admiten null y la llamada descarta los null para que
  la funcion aplique sus valores por defecto.
"""

import copy
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from mcp_server.server import mcp as kb_mcp
from youtube_mcp.server import mcp as yt_mcp
from youtube_mcp.utils.quota import QUOTA_COSTS

DESTRUCTIVE = {"youtube_delete_video"}
WRITE = {
    "youtube_upload_video",
    "youtube_update_video",
    "youtube_set_thumbnail",
    "youtube_post_comment",
    "youtube_reply_to_comment",
    "youtube_create_playlist",
    "youtube_add_to_playlist",
    "youtube_remove_from_playlist",
    "youtube_reporting_create_job",
}
# youtube_auth abre el navegador: solo desde POST /youtube/auth, nunca desde el modelo.
EXCLUDED = {"youtube_auth"}

JOB_KINDS = {"youtube_upload_video": "upload", "transcribe_local": "transcribe"}

# tool -> operacion de la tabla de cuota (QUOTA_COSTS). Sin entrada: coste desconocido/cero.
QUOTA_OP = {
    "youtube_upload_video": "video_insert",
    "youtube_update_video": "update",
    "youtube_set_thumbnail": "thumbnail_set",
    "youtube_delete_video": "delete",
    "youtube_post_comment": "insert",
    "youtube_reply_to_comment": "insert",
    "youtube_create_playlist": "insert",
    "youtube_add_to_playlist": "insert",
    "youtube_remove_from_playlist": "delete",
    "youtube_search": "search",
    "youtube_list_captions": "caption_list",
}


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict
    fn: Callable[..., Any]
    risk: str  # read | write | destructive
    quota: dict | None  # {"bucket": ..., "cost": ...}
    job_kind: str | None

    def call(self, args: dict) -> Any:
        """Llama a la funcion descartando los null (= usar el valor por defecto)."""
        return self.fn(**{k: v for k, v in args.items() if v is not None})


def risk_of(name: str) -> str:
    if name in DESTRUCTIVE:
        return "destructive"
    if name in WRITE:
        return "write"
    return "read"


def quota_of(name: str) -> dict | None:
    op = QUOTA_OP.get(name)
    if op is None:
        return None
    bucket, cost = QUOTA_COSTS[op]
    return {"bucket": bucket, "cost": cost}


def strict_schema(schema: dict) -> dict:
    """Esquema de MCP (pydantic) -> esquema apto para `strict: true`."""
    out = copy.deepcopy(schema)
    out.pop("title", None)
    props = out.get("properties", {})
    required = set(out.get("required", []))
    for name, prop in props.items():
        prop.pop("title", None)
        prop.pop("default", None)
        if name not in required and not _admits_null(prop):
            props[name] = {"anyOf": [prop, {"type": "null"}]}
    out["required"] = list(props)
    out["additionalProperties"] = False
    return out


def _admits_null(prop: dict) -> bool:
    if prop.get("type") == "null":
        return True
    return any(alt.get("type") == "null" for alt in prop.get("anyOf", []))


def build() -> list[ToolSpec]:
    specs = []
    for server in (yt_mcp, kb_mcp):
        # ponytail: `_tool_manager` es privado en mcp 2.x pero es la unica via de leer
        # fn + esquema sin levantar el servidor; cambiar si el SDK expone algo publico.
        for tool in server._tool_manager.list_tools():
            if tool.name in EXCLUDED:
                continue
            specs.append(
                ToolSpec(
                    name=tool.name,
                    description=tool.description,
                    input_schema=strict_schema(tool.parameters),
                    fn=tool.fn,
                    risk=risk_of(tool.name),
                    quota=quota_of(tool.name),
                    job_kind=JOB_KINDS.get(tool.name),
                )
            )
    return specs


def by_name(specs: list[ToolSpec]) -> dict[str, ToolSpec]:
    return {s.name: s for s in specs}
