"""Registro de tools: las funciones de ambos repos con riesgo, cuota y esquema estricto.

Las tools ya estan registradas en los `MCPServer` de cada repo; de ahi salen nombre,
descripcion, esquema y funcion. Aqui solo se anade lo que el agente necesita:

- `risk`: read (se ejecuta sin preguntar), write (gate de aprobacion) o
  destructive (aprobacion repitiendo el ID del video).
- `quota`: cubo y coste de la YouTube Data API, para mostrarlo en la propuesta.
- `job_kind`: las tools largas (subida, transcripcion) se ejecutan en la cola de jobs.
- `strict`: solo las tools write/destructive (la API admite 20 estrictas como maximo
  y es donde importa que los argumentos sean exactamente los del esquema). Su esquema
  pasa a additionalProperties=false con todos los campos requeridos. Los opcionales de
  texto o lista pasan a obligatorios sin null: "" o [] significa "no indicado". El resto
  de opcionales admite null (anyOf). La llamada descarta los null y los vacios de esos
  campos para que apliquen los valores por defecto (o "sin cambio" en las de update).

  Por que no todo con anyOf: la API limita a 16 los parametros con union (anyOf o
  `type: [...]`) sumando TODAS las tools estrictas, y con anyOf en cada opcional las
  estrictas sumaban 18 (400 en cualquier turno; HANDOFF-fase5.md, E2). Contrapartida:
  youtube_update_video no puede vaciar la descripcion o las etiquetas desde el agente.
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
    "guardar_en_kb_privada",
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

# Limite de la API para el conjunto de tools estrictas (ver test_registry).
MAX_STRICT_TOOLS = 20
MAX_STRICT_UNIONS = 16

_EMPTY_DESC = 'Empty string or empty list = not provided (default value, or unchanged on updates).'

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
    strict: bool = False
    omit_if_empty: frozenset[str] = frozenset()  # campos donde "" o [] = no indicado

    def clean_args(self, args: dict) -> dict:
        """Descarta los null y los vacios de `omit_if_empty` (= usar el valor por defecto).
        El agente lo aplica antes de la aprobacion y de encolar el job."""
        return {
            k: v
            for k, v in args.items()
            if v is not None and not (k in self.omit_if_empty and v in ("", []))
        }

    def call(self, args: dict) -> Any:
        return self.fn(**self.clean_args(args))


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
        if name in required:
            continue
        if (base := _empty_capable(prop)) is not None:
            props[name] = {**base, "description": _join_desc(prop.get("description"), _EMPTY_DESC)}
        elif not _admits_null(prop):
            props[name] = {"anyOf": [prop, {"type": "null"}]}
    out["required"] = list(props)
    out["additionalProperties"] = False
    return out


def omit_if_empty(schema: dict) -> frozenset[str]:
    """Opcionales que `strict_schema` convierte en texto/lista obligatorios ("" o [] = no indicado)."""
    required = set(schema.get("required", []))
    return frozenset(
        name
        for name, prop in schema.get("properties", {}).items()
        if name not in required and _empty_capable(prop) is not None
    )


def count_unions(schema: dict) -> int:
    """Parametros con union (anyOf/oneOf o `type: [...]`), como los cuenta la API."""
    return sum(
        1
        for prop in schema.get("properties", {}).values()
        if "anyOf" in prop or "oneOf" in prop or isinstance(prop.get("type"), list)
    )


def _empty_capable(prop: dict) -> dict | None:
    """Esquema base si el opcional es texto o lista (con o sin null), si no None."""
    alts = [prop]
    if "anyOf" in prop:
        alts = [a for a in prop["anyOf"] if a.get("type") != "null"]
        if len(alts) != len(prop["anyOf"]) - 1:
            return None
    if len(alts) != 1 or alts[0].get("type") not in ("string", "array") or "enum" in alts[0]:
        return None  # con enum "" no seria un valor valido
    base = {k: v for k, v in alts[0].items() if k not in ("title", "default")}
    if "description" in prop and "description" not in base:
        base["description"] = prop["description"]
    return base


def _join_desc(*partes: str | None) -> str:
    return " ".join(p.strip() for p in partes if p)


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
            risk = risk_of(tool.name)
            strict = risk != "read"
            specs.append(
                ToolSpec(
                    name=tool.name,
                    description=tool.description,
                    input_schema=strict_schema(tool.parameters) if strict else tool.parameters,
                    fn=tool.fn,
                    risk=risk,
                    quota=quota_of(tool.name),
                    job_kind=JOB_KINDS.get(tool.name),
                    strict=strict,
                    omit_if_empty=omit_if_empty(tool.parameters) if strict else frozenset(),
                )
            )
    return specs


def by_name(specs: list[ToolSpec]) -> dict[str, ToolSpec]:
    return {s.name: s for s in specs}
