"""Sidecar local del producto: FastAPI + agente sobre las tools de ambos repos.

Importar `config` aqui garantiza que las variables de entorno que lee
`youtube_mcp.server` al importarse (directorio de estado, almacen de secretos,
perfil, carpetas permitidas) esten fijadas antes que cualquier submodulo lo importe.
"""

from app_backend import config as _config  # noqa: F401
