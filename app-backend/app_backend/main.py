"""FastAPI del sidecar: escucha solo en 127.0.0.1, puerto aleatorio, token por arranque.

Al arrancar imprime una linea JSON en stdout con `port` y `token`; Tauri (Fase 3) la
leera y enviara el token en `Authorization: Bearer <token>` en cada peticion. Sin
el token, cualquier proceso local podria pedir al sidecar que suba o borre videos.
"""

import asyncio
import json
import logging
import secrets
import socket
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse
from youtube_mcp.auth import AuthError
from youtube_mcp.server import auth as yt_auth
from youtube_mcp.server import quota as yt_quota
from youtube_mcp.server import youtube_auth

from app_backend import config, registry
from app_backend.agent import Agent
from app_backend.approvals import Approvals
from app_backend.jobs import Jobs
from app_backend.kb_update import KBUpdateError, KBUpdater

_bearer = HTTPBearer(auto_error=False)
log = logging.getLogger("app_backend")


def _calentar_kb() -> None:
    """Carga el modelo de embeddings (varios segundos en frio) para que la primera busqueda sea rapida."""
    try:
        from kb import embeddings

        embeddings.embed_query("calentamiento")
    except Exception as e:  # noqa: BLE001 - solo es una optimizacion
        log.warning("No se pudo precargar el modelo de embeddings: %s", e)


def create_app(
    token: str,
    *,
    client_factory=None,
    jobs_path: str | Path | None = None,
    kb_updater: KBUpdater | None = None,
    kb_auto_update: bool = True,
) -> FastAPI:
    specs = registry.build()
    tools = registry.by_name(specs)
    approvals = Approvals()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        config.STATE_DIR.mkdir(parents=True, exist_ok=True)
        app.state.jobs = Jobs(
            jobs_path or config.STATE_DIR / "jobs.sqlite",
            {kind: tools[name].fn for name, kind in registry.JOB_KINDS.items()},
        )
        app.state.jobs.start()
        app.state.agent = Agent(specs, approvals, app.state.jobs, client_factory=client_factory)
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

    def require_token(creds: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> None:  # noqa: B008
        if creds is None or not secrets.compare_digest(creds.credentials, token):
            raise HTTPException(status_code=401, detail="Token invalido o ausente.")

    protegido = [Depends(require_token)]

    # ------------------------------------------------------------------- chat

    class ChatIn(BaseModel):
        message: str = Field(min_length=1)
        conversation_id: str | None = None

    @app.post("/chat", dependencies=protegido)
    async def chat(body: ChatIn, request: Request):
        agent: Agent = app.state.agent
        settings = config.load_settings()
        api_key = config.anthropic_api_key(yt_auth.store)
        if not api_key:
            raise HTTPException(status_code=409, detail="Falta la clave de Anthropic (PUT /settings).")
        conv = agent.conversation(body.conversation_id)
        if conv.lock.locked():
            raise HTTPException(status_code=409, detail="Esta conversacion ya tiene un turno en curso.")

        events: asyncio.Queue = asyncio.Queue()

        async def turno():
            async with conv.lock:
                await agent.run_turn(
                    conv, body.message, events, api_key=api_key, model=settings["model"]
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

    @app.get("/kb/fuentes", dependencies=protegido)
    async def kb_fuentes(plataforma: str | None = None):
        return {"texto": await asyncio.to_thread(tools["listar_fuentes"].fn, plataforma)}

    @app.get("/kb/buscar", dependencies=protegido)
    async def kb_buscar(q: str, plataforma: str | None = None, k: int = 3):
        fn = tools["buscar_kb"].fn
        return {"texto": await asyncio.to_thread(fn, q, plataforma, None, None, None, k)}

    # ---------------------------------------------------------------- youtube

    class YouTubeAuthIn(BaseModel):
        profile: str | None = None
        reauthorize: bool = False

    @app.get("/youtube/status", dependencies=protegido)
    async def youtube_status():
        return {"auth": yt_auth.status(), "quota": yt_quota.status()}

    @app.post("/youtube/auth", dependencies=protegido)
    async def youtube_authorize(body: YouTubeAuthIn):
        # Unica ruta que abre el navegador: la pide el usuario desde la UI, no el modelo.
        return await asyncio.to_thread(youtube_auth, body.profile, body.reauthorize)

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

    def settings_out() -> dict:
        s = config.load_settings()
        return {
            **s,
            "models": list(config.MODELS),
            "has_anthropic_key": config.anthropic_api_key(yt_auth.store) is not None,
            "has_client_secret": yt_auth.has_client_secret(),
            "state_dir": str(config.STATE_DIR),
            "secret_store": type(yt_auth.store).__name__,
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

    @app.post("/settings/client-secret", dependencies=protegido)
    async def put_client_secret(body: ClientSecretIn):
        source = body.json_text or body.path
        if not source:
            raise HTTPException(status_code=400, detail="Indica path o json_text.")
        try:
            yt_auth.import_client_secret(source)
        except (AuthError, OSError) as e:
            raise HTTPException(status_code=400, detail=str(e))
        return settings_out()

    return app


def main() -> None:
    import os

    import uvicorn

    token = os.environ.get("APP_BACKEND_TOKEN") or secrets.token_urlsafe(32)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))  # nunca 0.0.0.0: el sidecar es local
    port = sock.getsockname()[1]
    print(json.dumps({"port": port, "token": token}), flush=True)
    app = create_app(token)
    uvicorn.Server(uvicorn.Config(app, log_level="info")).run(sockets=[sock])


if __name__ == "__main__":
    main()
