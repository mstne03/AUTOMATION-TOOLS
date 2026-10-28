"""Spike D6 (desechable): sirve una `_composicion/` ya montada para la preview en un iframe.

Solo se monta con `APP_BACKEND_SPIKES=1` (ver `main.create_app`); nunca en producción.

- URL de capacidad: `GET /spike/preview/{clave}/{ruta}`. El iframe no puede mandar la cabecera
  Bearer, así que la ruta lleva una clave aleatoria generada al arrancar (la ruta de
  información, que la entrega, sí exige el token).
- Toda ruta pedida se resuelve con `Path.resolve()` y se comprueba que cuelga de la carpeta de
  la composición: `..`, rutas absolutas y enlaces que escapen devuelven 404.
- Al `index.html` se le inyecta el runtime de HyperFrames y un script de control que escucha
  `postMessage` desde la página padre (ver `CONTROL_JS`).
"""

import secrets
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, Response

# El iframe lleva `sandbox="allow-scripts"` sin `allow-same-origin`: su origen es opaco (`null`),
# así que `fetch` de subcomposiciones y fuentes necesita CORS. Es contenido de solo lectura bajo
# una URL no adivinable.
_CABECERAS = {
    "Access-Control-Allow-Origin": "*",
    # Aunque alguien abra la URL directamente, el documento sigue sandboxed (sin origen propio).
    "Content-Security-Policy": "sandbox allow-scripts",
    "Cache-Control": "no-store",
}

# Se inyecta justo tras <head>: primero el runtime (carga subcomposiciones y sincroniza medios),
# después el control. Rutas relativas: funcionan con `/…/{clave}/` y con `/…/{clave}/index.html`.
_INYECCION = '<script src="__spike/runtime.js"></script><script src="__spike/control.js"></script>'

# Corre dentro del iframe. Valida la forma de cada mensaje (origen = ventana padre, objeto, `tipo`
# de una lista cerrada, `t` numérico finito) y delega en `window.__player` del runtime, que ya
# hace seek del timeline y sincroniza los <audio>/<video>.
CONTROL_JS = r"""(() => {
  "use strict";
  const padre = window.parent;
  const responder = (m) => padre.postMessage(m, "*"); // origen opaco: no hay otro destino posible
  const num = (v, min, max) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null);
  const dosFrames = () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  let ocupado = false;

  async function fps(ms) {
    const t0 = performance.now(); let n = 0, peor = 0, previo = t0;
    await new Promise((ok) => {
      const paso = (t) => { n++; peor = Math.max(peor, t - previo); previo = t; (t - t0 < ms) ? requestAnimationFrame(paso) : ok(); };
      requestAnimationFrame(paso);
    });
    const seg = (performance.now() - t0) / 1000;
    return { fps: n / seg, fotogramas: n, segundos: seg, peorIntervaloMs: peor };
  }

  async function deriva(segundos) {
    const p = window.__player, audio = document.querySelector("audio");
    p.seek(0); await dosFrames(); p.play();
    const t0 = performance.now(), muestras = [];
    await new Promise((ok) => {
      const id = setInterval(() => {
        const pared = (performance.now() - t0) / 1000;
        muestras.push({ pared, tl: p.getTime(), audio: audio ? audio.currentTime : null });
        if (pared >= segundos) { clearInterval(id); ok(); }
      }, 250);
    });
    p.pause();
    return { muestras };
  }

  addEventListener("message", async (e) => {
    if (e.source !== padre) return;
    const d = e.data;
    if (!d || typeof d !== "object" || typeof d.tipo !== "string") return;
    const p = window.__player;
    if (!p) return responder({ tipo: "error", id: d.id, motivo: "runtime no listo" });
    try {
      switch (d.tipo) {
        case "seek": {
          const t = num(d.t, 0, p.getDuration() || 0);
          if (t === null) return;
          const t0 = performance.now();
          p.seek(t);
          const tSeek = performance.now() - t0;
          await dosFrames();
          return responder({ tipo: "seek-hecho", id: d.id, t, msSeek: tSeek, msHastaPintar: performance.now() - t0 });
        }
        case "play": return p.play();
        case "pause": return p.pause();
        case "medir-fps": { const ms = num(d.ms, 500, 60000); if (ms === null || ocupado) return; ocupado = true;
          try { return responder({ tipo: "fps", id: d.id, ...(await fps(ms)) }); } finally { ocupado = false; } }
        case "medir-deriva": { const s = num(d.segundos, 1, 120); if (s === null || ocupado) return; ocupado = true;
          try { return responder({ tipo: "deriva", id: d.id, ...(await deriva(s)) }); } finally { ocupado = false; } }
        case "estado": return responder({ tipo: "estado", id: d.id, t: p.getTime(), duracion: p.getDuration(), reproduciendo: p.isPlaying() });
      }
    } catch (err) { responder({ tipo: "error", id: d.id, motivo: String(err && err.message || err) }); }
  });
  const aviso = () => responder({ tipo: "listo", duracion: window.__player ? window.__player.getDuration() : null });
  window.__playerReady ? aviso() : addEventListener("load", () => setTimeout(aviso, 500));
})();
"""


def resolver(carpeta: Path, ruta: str) -> Path | None:
    """Devuelve el fichero de `ruta` dentro de `carpeta`, o None si se sale o no existe."""
    base = carpeta.resolve()
    try:
        destino = (base / ruta).resolve()
    except (OSError, ValueError):  # p. ej. NUL en la ruta
        return None
    # `ruta` absoluta ("/etc/x", "C:/x") hace que `/` descarte `base`: la comprobación de prefijo lo para.
    if not destino.is_relative_to(base) or not destino.is_file():
        return None
    return destino


def crear_router(carpeta: Path, runtime: Path | None, clave: str) -> APIRouter:
    router = APIRouter()

    @router.get("/spike/preview/{clave_url}/{ruta:path}")
    async def servir(clave_url: str, ruta: str):
        if not secrets.compare_digest(clave_url, clave):
            raise HTTPException(status_code=404)
        if ruta == "__spike/control.js":
            return Response(CONTROL_JS, media_type="text/javascript", headers=_CABECERAS)
        if ruta == "__spike/runtime.js":
            if runtime is None or not runtime.is_file():
                raise HTTPException(status_code=404)
            return FileResponse(runtime, media_type="text/javascript", headers=_CABECERAS)
        fichero = resolver(carpeta, ruta or "index.html")
        if fichero is None:
            raise HTTPException(status_code=404)
        if fichero.name == "index.html" and fichero.parent == carpeta.resolve():
            html = fichero.read_text(encoding="utf-8")
            cabeza = html.lower().find("<head>")
            i = cabeza + len("<head>") if cabeza >= 0 else 0
            return HTMLResponse(html[:i] + _INYECCION + html[i:], headers=_CABECERAS)
        return FileResponse(fichero, headers=_CABECERAS)  # FileResponse atiende Range (audio/vídeo)

    return router


def montar(app, protegido: list, carpeta: Path, runtime: Path | None) -> str:
    """Monta el router en `app` y la ruta de información (con Bearer) que entrega la URL con la clave."""
    clave = secrets.token_urlsafe(32)
    app.include_router(crear_router(carpeta, runtime, clave))

    @app.get("/spike/preview-info", dependencies=protegido)
    async def info():
        return {"ruta": f"/spike/preview/{clave}/"}

    return clave
