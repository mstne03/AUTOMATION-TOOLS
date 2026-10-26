"""FastAPI del sidecar: escucha solo en 127.0.0.1, puerto aleatorio, token por arranque.

Al arrancar imprime una linea JSON en stdout con `port` y `token`; Tauri (Fase 3) la
leera y enviara el token en `Authorization: Bearer <token>` en cada peticion. Sin
el token, cualquier proceso local podria pedir al sidecar que suba o borre videos.
"""

import asyncio
import json
import logging
import os
import secrets
import socket
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from anthropic import (
    APIConnectionError,
    APIStatusError,
    AsyncAnthropic,
    AuthenticationError,
    PermissionDeniedError,
)
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse
from youtube_mcp.auth import AuthError, ClientSecretConflict
from youtube_mcp.server import auth as yt_auth
from youtube_mcp.server import quota as yt_quota
from youtube_mcp.server import youtube_auth

from app_backend import config, registry
from app_backend.agent import Agent, ConversacionOcupada
from app_backend.approvals import Approvals
from app_backend.canal import METRICAS, CanalCache, CanalError, Fuentes
from app_backend.conversaciones import Almacen
from app_backend.jobs import Jobs
from app_backend.kb_update import KBUpdateError, KBUpdater

_bearer = HTTPBearer(auto_error=False)
log = logging.getLogger("app_backend")

# Origenes del WebView de Tauri 2 (produccion y `tauri dev`). Nada mas.
CORS_ORIGINS = ["http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"]


def _calentar_kb() -> None:
    """Carga el modelo de embeddings (varios segundos en frio) para que la primera busqueda sea rapida."""
    try:
        from kb import embeddings

        embeddings.embed_query("calentamiento")
    except Exception as e:  # noqa: BLE001 - solo es una optimizacion
        log.warning("No se pudo precargar el modelo de embeddings: %s", e)


def _fuentes_reales(tools: dict) -> Fuentes:
    """Lecturas reales de youtube_mcp (las mismas funciones que usa el agente, sin pasar por él)."""
    from youtube_mcp.tools.analytics import _run_analytics_query

    def estado(ids: list[str]) -> dict[str, dict]:
        yt_quota.consume("list")
        r = yt_auth.build_youtube_service().videos().list(part="status", id=",".join(ids)).execute()
        return {
            v["id"]: {"privacy": v.get("status", {}).get("privacyStatus"), "publish_at": v.get("status", {}).get("publishAt")}
            for v in r.get("items", [])
        }

    def analytics(inicio: str, fin: str) -> dict:
        r = _run_analytics_query(metrics=METRICAS, start_date=inicio, end_date=fin)
        return r["results"][0] if r["results"] else {}

    return Fuentes(
        canal=lambda: tools["youtube_get_channel"].fn(mine=True),
        videos=lambda n: tools["youtube_list_videos"].fn(mine=True, max_results=n),
        estado=estado,
        analytics=analytics,
    )


def create_app(
    token: str,
    *,
    client_factory=None,
    jobs_path: str | Path | None = None,
    kb_updater: KBUpdater | None = None,
    kb_auto_update: bool = True,
    canal_fuentes: Fuentes | None = None,
    conversaciones_dir: str | Path | None = None,
) -> FastAPI:
    specs = registry.build()
    tools = registry.by_name(specs)
    approvals = Approvals()
    canal_cache = CanalCache(canal_fuentes or _fuentes_reales(tools))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        config.STATE_DIR.mkdir(parents=True, exist_ok=True)
        app.state.jobs = Jobs(
            jobs_path or config.STATE_DIR / "jobs.sqlite",
            {kind: tools[name].fn for name, kind in registry.JOB_KINDS.items()},
        )
        app.state.jobs.start()
        app.state.agent = Agent(
            specs,
            approvals,
            app.state.jobs,
            client_factory=client_factory,
            almacen=Almacen(conversaciones_dir or config.STATE_DIR / "conversaciones"),
        )
        app.state.kb_updater = kb_updater or KBUpdater(
            config.KB_UPDATE_URL, config.KB_MINISIGN_PUBKEY, config.KB_PUBLIC_PATH
        )
        tareas = []
        if kb_auto_update:
            tareas.append(asyncio.create_task(_arranque_kb(app.state.kb_updater)))
        yield
        for t in tareas:
            t.cancel()
        await app.state.jobs.stop()

    async def _arranque_kb(updater: KBUpdater) -> None:
        """Al arrancar: comprobar el snapshot si toca (diario) y calentar el modelo."""
        if updater.due():
            try:
                r = await asyncio.to_thread(updater.update)
                log.info("KB: %s", r)
            except KBUpdateError as e:
                log.warning("KB: %s", e)
        await asyncio.to_thread(_calentar_kb)

    app = FastAPI(title="app-backend", lifespan=lifespan)
    # El WebView de Tauri tiene origen propio (tauri.localhost; localhost:1420 en desarrollo),
    # asi que el navegador exige CORS. Solo esos origenes; el token sigue siendo obligatorio.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    def require_token(creds: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> None:  # noqa: B008
        if creds is None or not secrets.compare_digest(creds.credentials, token):
            raise HTTPException(status_code=401, detail="Token invalido o ausente.")

    protegido = [Depends(require_token)]

    # ------------------------------------------------------------------- chat

    class ChatIn(BaseModel):
        message: str = Field(min_length=1)
        conversation_id: str | None = None
        # "Usar KB" apagado: el sidecar se lo indica al modelo sin tocar el texto guardado.
        sin_kb: bool = False
        # Publicar usa conversaciones de trabajo que no van a la lista de chats.
        persistir: bool = True

    @app.post("/chat", dependencies=protegido)
    async def chat(body: ChatIn, request: Request):
        agent: Agent = app.state.agent
        settings = config.load_settings()
        api_key = config.anthropic_api_key(yt_auth.store)
        if not api_key:
            raise HTTPException(status_code=409, detail="Falta la clave de Anthropic (PUT /settings).")
        conv = agent.conversation(body.conversation_id, perfil=yt_auth.profile, persistir=body.persistir)
        if conv.lock.locked():
            raise HTTPException(status_code=409, detail="Esta conversacion ya tiene un turno en curso.")

        events: asyncio.Queue = asyncio.Queue()

        async def turno():
            async with conv.lock:
                await agent.run_turn(
                    conv, body.message, events, api_key=api_key, model=settings["model"], sin_kb=body.sin_kb
                )

        task = asyncio.create_task(turno())

        async def generar():
            try:
                while True:
                    ev = await events.get()
                    yield {"event": ev["type"], "data": json.dumps(ev, ensure_ascii=False, default=str)}
                    if ev["type"] in ("done", "error"):
                        break
            finally:
                if not task.done():
                    task.cancel()  # cliente desconectado: cancela el turno y sus aprobaciones

        return EventSourceResponse(generar())

    @app.get("/conversations", dependencies=protegido)
    async def list_conversations():
        return await asyncio.to_thread(app.state.agent.listar)

    @app.get("/conversations/{conversation_id}", dependencies=protegido)
    async def get_conversation(conversation_id: str):
        datos = await asyncio.to_thread(app.state.agent.detalle, conversation_id)
        if datos is None:
            raise HTTPException(status_code=404, detail="Conversación no encontrada.")
        return datos

    @app.delete("/conversations/{conversation_id}", dependencies=protegido)
    async def delete_conversation(conversation_id: str):
        try:
            borrada = app.state.agent.borrar(conversation_id)
        except ConversacionOcupada:
            raise HTTPException(status_code=409, detail="La conversación tiene una respuesta en curso: cancélala antes de borrarla.")
        if not borrada:
            raise HTTPException(status_code=404, detail="Conversación no encontrada.")
        return {"borrada": conversation_id}

    # -------------------------------------------------------------- approvals

    class ApprovalIn(BaseModel):
        decision: str
        confirm_id: str | None = None

    @app.get("/approvals", dependencies=protegido)
    async def list_approvals():
        return [a.to_dict() for a in approvals.pending()]

    @app.post("/approvals/{approval_id}", dependencies=protegido)
    async def resolve_approval(approval_id: str, body: ApprovalIn):
        try:
            return approvals.resolve(approval_id, body.decision, body.confirm_id).to_dict()
        except KeyError:
            raise HTTPException(status_code=404, detail="Propuesta no encontrada.")
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    # ------------------------------------------------------------------- jobs

    class JobIn(BaseModel):
        kind: str
        args: dict[str, Any]

    @app.get("/jobs", dependencies=protegido)
    async def list_jobs():
        return app.state.jobs.list()

    @app.post("/jobs", dependencies=protegido, status_code=202)
    async def create_job(body: JobIn):
        try:
            return app.state.jobs.enqueue(body.kind, body.args)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    @app.get("/jobs/{job_id}", dependencies=protegido)
    async def get_job(job_id: str):
        try:
            return app.state.jobs.get(job_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job no encontrado.")

    # --------------------------------------------------------------------- kb

    @app.get("/kb/estado", dependencies=protegido)
    async def kb_estado():
        return {
            "texto": await asyncio.to_thread(tools["estado_kb"].fn),
            "snapshot": app.state.kb_updater.estado(),
        }

    @app.post("/kb/update", dependencies=protegido)
    async def kb_update():
        try:
            return await asyncio.to_thread(app.state.kb_updater.update)
        except KBUpdateError as e:
            raise HTTPException(status_code=502, detail=str(e))

    @app.post("/kb/rollback", dependencies=protegido)
    async def kb_rollback():
        try:
            return await asyncio.to_thread(app.state.kb_updater.rollback)
        except KBUpdateError as e:
            raise HTTPException(status_code=409, detail=str(e))

    # ------------------------------------------------------------ kb privada

    class FuentePrivadaIn(BaseModel):
        url: str = Field(min_length=1)
        type: str | None = None          # web | youtube | pdf | browser (se adivina)
        title: str | None = None
        platforms: list[str] | None = None
        published_at: str | None = None
        author: str | None = None

    class NotaPrivadaIn(BaseModel):
        identificador: str = Field(min_length=1)
        titulo: str = Field(min_length=1)
        texto: str = Field(min_length=1)
        platforms: list[str] | None = None
        published_at: str | None = None

    class UrlIn(BaseModel):
        url: str = Field(min_length=1)

    def _privada():
        from kb import sqlite_kb

        return sqlite_kb, config.KB_PRIVATE_PATH

    @app.get("/kb/privada/fuentes", dependencies=protegido)
    async def kb_privada_fuentes():
        sqlite_kb, path = _privada()
        if not path.exists():
            return []

        def listar():
            conn = sqlite_kb.connect(path)
            try:
                return [
                    {"title": t, "url": u, "published_at": p, "platforms": pl}
                    for t, u, p, pl in sqlite_kb.listar_fuentes(conn)
                ]
            finally:
                conn.close()

        return await asyncio.to_thread(listar)

    @app.post("/kb/privada/fuentes", dependencies=protegido, status_code=201)
    async def kb_privada_add(body: FuentePrivadaIn):
        from ingest.cli import ExtractionError, ingest_one

        # Solo URLs: los ficheros locales entran por las tools con carpetas permitidas.
        if not body.url.lower().startswith(("http://", "https://")):
            raise HTTPException(status_code=400, detail="Solo se admiten URLs http(s).")
        source = {k: v for k, v in body.model_dump().items() if v is not None}
        try:
            r = await asyncio.to_thread(ingest_one, source, config.KB_PRIVATE_PATH)
        except ExtractionError as e:
            raise HTTPException(status_code=422, detail=str(e))
        return {"url": body.url, **r}

    @app.post("/kb/privada/notas", dependencies=protegido, status_code=201)
    async def kb_privada_nota(body: NotaPrivadaIn):
        from ingest.cli import ExtractionError, ingest_text

        try:
            r = await asyncio.to_thread(
                ingest_text, config.KB_PRIVATE_PATH, body.identificador, body.titulo,
                body.texto, body.platforms, body.published_at,
            )
        except ExtractionError as e:
            raise HTTPException(status_code=422, detail=str(e))
        return {"url": body.identificador, **r}

    @app.delete("/kb/privada/fuentes", dependencies=protegido)
    async def kb_privada_delete(body: UrlIn):
        sqlite_kb, path = _privada()
        if not path.exists():
            raise HTTPException(status_code=404, detail="La KB privada esta vacia.")

        def borrar() -> bool:
            conn = sqlite_kb.connect(path, readonly=False)
            try:
                ok = sqlite_kb.delete_document(conn, body.url)
                conn.commit()
                return ok
            finally:
                conn.close()

        if not await asyncio.to_thread(borrar):
            raise HTTPException(status_code=404, detail="No hay ningun documento con esa url.")
        return {"borrada": body.url}

    @app.get("/kb/fuentes", dependencies=protegido)
    async def kb_fuentes(plataforma: str | None = None, formato: str | None = None):
        # Sin `formato` el texto es el que lee el agente; con formato=json, la lista para pintar tarjetas.
        if formato == "json":
            from mcp_server.server import fuentes_estructuradas

            return await _kb_json(fuentes_estructuradas, plataforma)
        return {"texto": await asyncio.to_thread(tools["listar_fuentes"].fn, plataforma)}

    @app.get("/kb/buscar", dependencies=protegido)
    async def kb_buscar(q: str, plataforma: str | None = None, k: int = 3, formato: str | None = None):
        if formato == "json":
            from mcp_server.server import buscar_estructurado

            return await _kb_json(buscar_estructurado, q, plataforma, k)
        fn = tools["buscar_kb"].fn
        return {"texto": await asyncio.to_thread(fn, q, plataforma, None, None, None, k)}

    async def _kb_json(fn, *args):
        try:
            return await asyncio.to_thread(fn, *args)
        except Exception as e:
            log.warning("KB: %s: %s", type(e).__name__, e)
            raise HTTPException(status_code=503, detail=f"La base de conocimiento no está disponible: {type(e).__name__}.") from e

    # ---------------------------------------------------------------- guiones

    @app.get("/guiones/retencion", dependencies=protegido)
    async def guiones_retencion(
        video_id: str = Query(pattern=r"^[A-Za-z0-9_-]{11}$"),
        format: Literal["long", "short"] = "long",
        language: str = Query("es", pattern=r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$"),
    ):
        # Sin el modelo: la pantalla pinta la curva al momento y la cuota se gasta una vez.
        # El patrón del ID evita meter texto arbitrario en el filtro de Analytics (video==...).
        fn = tools["youtube_retention_moments"].fn
        return await asyncio.to_thread(fn, video_id, format, language)

    # ---------------------------------------------------------------- youtube

    class YouTubeAuthIn(BaseModel):
        profile: str | None = None
        reauthorize: bool = False

    @app.get("/youtube/status", dependencies=protegido)
    async def youtube_status():
        # status() puede renovar el token con Google (red): fuera del bucle de eventos.
        return {"auth": await asyncio.to_thread(yt_auth.status), "quota": yt_quota.status()}

    @app.get("/youtube/channel", dependencies=protegido)
    async def youtube_channel(refresh: bool = False):
        """Canal, métricas de 28 días y últimos vídeos para el Panel de canal (caché de 10 min)."""
        estado = await asyncio.to_thread(yt_auth.status)
        if not estado.get("authenticated"):
            raise HTTPException(status_code=409, detail="El canal no está autorizado: autorízalo en Ajustes.")
        try:
            return await asyncio.to_thread(canal_cache.obtener, estado["profile"], refresh)
        except CanalError as e:
            raise HTTPException(status_code=502, detail=f"No se pudo leer el canal: {e}") from e
        except AuthError as e:
            raise HTTPException(status_code=409, detail=str(e)) from e

    @app.post("/youtube/auth", dependencies=protegido)
    async def youtube_authorize(body: YouTubeAuthIn):
        # Unica ruta que abre el navegador: la pide el usuario desde la UI, no el modelo.
        if not yt_auth.has_client_secret():
            raise HTTPException(
                status_code=409,
                detail="Falta el client_secret.json del proyecto de Google Cloud: impórtalo antes de autorizar un canal.",
            )
        r = await asyncio.to_thread(youtube_auth, body.profile, body.reauthorize)
        if r.get("status") == "error":
            raise HTTPException(status_code=400, detail=r.get("detail", "Fallo al autorizar."))
        return r

    @app.post("/youtube/auth/cancel", dependencies=protegido)
    async def youtube_authorize_cancel():
        """Corta la autorización en curso (el usuario cerró la pestaña de Google o pulsó Cancelar):
        la petición POST /youtube/auth pendiente responde entonces con "Autorización cancelada"."""
        return {"cancelada": await asyncio.to_thread(yt_auth.cancel_interactive)}

    @app.get("/youtube/tools", dependencies=protegido)
    async def youtube_tools():
        return [
            {"name": s.name, "risk": s.risk, "quota": s.quota, "job_kind": s.job_kind}
            for s in specs
        ]

    # --------------------------------------------------------------- settings

    class SettingsIn(BaseModel):
        model: str | None = None
        allowed_dirs: list[dict] | None = None
        profile: str | None = None
        anthropic_api_key: str | None = None

    class ClientSecretIn(BaseModel):
        path: str | None = None
        json_text: str | None = None
        # Sustituir un proyecto de Google por otro desautoriza todos los canales: la UI lo confirma antes.
        replace: bool = False

    def settings_out() -> dict:
        s = config.load_settings()
        return {
            **s,
            "models": list(config.MODELS),
            "has_anthropic_key": config.anthropic_api_key(yt_auth.store) is not None,
            "has_client_secret": yt_auth.has_client_secret(),
            "google_project": yt_auth.client_info(),
            "state_dir": str(config.STATE_DIR),
            "secret_store": type(yt_auth.store).__name__,
            # Diagnostico para el smoke test: debe ser None (si no, Whisper no puede bajar su modelo).
            "hf_hub_offline": os.environ.get("HF_HUB_OFFLINE"),
        }

    @app.get("/settings", dependencies=protegido)
    async def get_settings():
        return settings_out()

    @app.put("/settings", dependencies=protegido)
    async def put_settings(body: SettingsIn):
        s = config.load_settings()
        if body.model is not None:
            if body.model not in config.MODELS:
                raise HTTPException(status_code=400, detail=f"model debe ser uno de {config.MODELS}")
            s["model"] = body.model
        if body.allowed_dirs is not None:
            s["allowed_dirs"] = [
                {"path": str(d.get("path", "")), "language": d.get("language") or None}
                for d in body.allowed_dirs
                if d.get("path")
            ]
        if body.profile is not None:
            try:
                yt_auth.use_profile(body.profile)
            except AuthError as e:
                raise HTTPException(status_code=400, detail=str(e))
            s["profile"] = yt_auth.profile
        if body.anthropic_api_key is not None:
            if body.anthropic_api_key:
                yt_auth.store.set(config.ANTHROPIC_KEY, body.anthropic_api_key)
            else:
                yt_auth.store.delete(config.ANTHROPIC_KEY)
        config.save_settings(s)
        config.apply_env(s)
        return settings_out()

    class ValidarClaveIn(BaseModel):
        api_key: str | None = None  # sin ella, se valida la clave guardada

    @app.post("/settings/validate-key", dependencies=protegido)
    async def validate_key(body: ValidarClaveIn):
        """Comprueba la clave de Anthropic con la llamada más barata (GET /v1/models, sin coste)."""
        clave = body.api_key or config.anthropic_api_key(yt_auth.store)
        if not clave:
            raise HTTPException(status_code=400, detail="No hay ninguna clave que validar.")
        cliente = (client_factory or (lambda k: AsyncAnthropic(api_key=k)))(clave)
        try:
            await cliente.models.list(limit=1)
        except AuthenticationError:
            return {"valida": False, "detalle": "Anthropic no reconoce esta clave."}
        except PermissionDeniedError:
            return {"valida": False, "detalle": "Esta clave no tiene permiso para usar la API."}
        except APIConnectionError as e:
            raise HTTPException(status_code=502, detail="No se pudo conectar con Anthropic: comprueba tu conexión.") from e
        except APIStatusError as e:
            raise HTTPException(status_code=502, detail=f"Anthropic respondió con un error ({e.status_code}).") from e
        return {"valida": True, "detalle": None}

    @app.post("/settings/client-secret", dependencies=protegido)
    async def put_client_secret(body: ClientSecretIn):
        source = body.json_text or body.path
        if not source:
            raise HTTPException(status_code=400, detail="Indica path o json_text.")
        try:
            r = yt_auth.import_client_secret(source, replace=body.replace)
        except ClientSecretConflict as e:
            raise HTTPException(status_code=409, detail=str(e))
        except (AuthError, OSError) as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {**settings_out(), "desautorizados": r["desautorizados"]}

    @app.delete("/settings/client-secret", dependencies=protegido)
    async def delete_client_secret():
        """Quita el proyecto de Google y, con él, la autorización de todos los canales."""
        desautorizados = yt_auth.remove_client_secret()
        return {**settings_out(), "desautorizados": desautorizados}

    return app


def main() -> None:
    import os

    import uvicorn

    token = os.environ.get("APP_BACKEND_TOKEN") or secrets.token_urlsafe(32)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))  # nunca 0.0.0.0: el sidecar es local
    port = sock.getsockname()[1]
    # listen() antes de anunciar el puerto: las conexiones que lleguen mientras uvicorn
    # termina de arrancar (varios segundos de imports) quedan en cola en vez de rechazarse.
    sock.listen(128)
    print(json.dumps({"port": port, "token": token}), flush=True)
    app = create_app(token)
    uvicorn.Server(uvicorn.Config(app, log_level="info")).run(sockets=[sock])


if __name__ == "__main__":
    main()
