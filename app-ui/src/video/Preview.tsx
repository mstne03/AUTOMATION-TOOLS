/** Preview del editor (T17, D6, I8): composición de HyperFrames en un iframe aislado.
 *
 *  - La preview se abre SOLO por la `SesionPreview` del editor (`sesionPreview()`, guardada al
 *    montar): ahí viven el cierre, los temporizadores y la invalidación de claves.
 *  - El `src` del iframe sale de `aPreviewUrl` (loopback y puertos 47810–47813), nunca del servidor
 *    tal cual.
 *  - `sandbox="allow-scripts"` exacto, sin `allow-same-origin`, `allow-popups` ni
 *    `allow-top-navigation`.
 *  - Los mensajes entrantes se validan en `previewProtocolo.ts` (origen, `source`, esquema cerrado).
 *  - Todo texto (avisos, errores, tiempos) se pinta como texto. */
import { Pause, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { sinRutas } from "../screens/MotorVideo";
import { aFrase } from "./render/resultado";
import { fijarTiempo, useEditor } from "../state/editor";
import { IconButton } from "../ui";
import type { AvisoPreview } from "../api/types";
import { sesionPreview } from "./EditorPreview";
import { aPreviewUrl } from "./modelo";
import s from "./Preview.module.css";
import {
  enviarOrden,
  LimitadorMensajes,
  validarMensajeIframe,
  type OrdenIframe,
} from "./previewProtocolo";
import { usePreviewRecarga } from "./previewRecarga";

const ANCHO = 1080;
const ALTO = 1920;
export const ESPERA_RECARGA_MS = 400;
const MAX_PENDIENTES = 64;

type Estado = { tipo: "abriendo" | "cargando" | "listo" } | { tipo: "error"; mensaje: string };

const formato = (t: number) => {
  const n = Math.max(0, Math.floor(t));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};
const hayWebgpu = () => typeof navigator !== "undefined" && "gpu" in navigator;

export function Preview() {
  // La sesión se guarda al montar: si el editor cambia de proyecto, esta preview ya no es válida.
  const [sesion] = useState(() => sesionPreview());
  const proyectoId = useEditor((e) => e.proyecto?.id ?? null);
  const revision = useEditor((e) => e.revision);
  const tiempo = useEditor((e) => e.tiempo);
  const recarga = usePreviewRecarga((r) => r.contador);

  const [estado, setEstado] = useState<Estado>({ tipo: "abriendo" });
  const [src, setSrc] = useState<{ url: string; n: number } | null>(null);
  const [avisos, setAvisos] = useState<AvisoPreview[]>([]);
  const [reproduciendo, setReproduciendo] = useState(false);
  const [tActual, setTActual] = useState(0);
  const [duracion, setDuracion] = useState(0);
  const [escala, setEscala] = useState(1);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const escenarioRef = useRef<HTMLDivElement | null>(null);
  const duracionRef = useRef(0);
  const ultimoT = useRef(0);
  const listoRef = useRef(false);
  const pendientes = useRef(new Set<number>());
  const siguienteId = useRef(0);
  const generacion = useRef(0);
  const descartados = useRef(0);
  const limitador = useRef(new LimitadorMensajes());
  const montada = useRef(true);
  const claveDisparada = useRef<string | null>(null);

  const coincide = sesion !== null && proyectoId !== null && sesion.id === proyectoId;

  const abrir = useCallback(async () => {
    if (!sesion) return;
    const gen = ++generacion.current;
    listoRef.current = false;
    pendientes.current.clear();
    setEstado((e) => (e.tipo === "listo" ? { tipo: "cargando" } : e.tipo === "error" ? { tipo: "abriendo" } : e));
    try {
      const r = await sesion.abrir(hayWebgpu());
      if (r === null || !montada.current || gen !== generacion.current) return; // sesión cerrada o respuesta vieja
      const url = aPreviewUrl(r.url);
      if (url === null) {
        setSrc(null);
        setEstado({ tipo: "error", mensaje: "La preview devolvió una dirección no permitida." });
        return;
      }
      duracionRef.current = Number.isFinite(r.duracion) && r.duracion > 0 ? r.duracion : 0;
      setDuracion(duracionRef.current);
      setAvisos(Array.isArray(r.avisos) ? r.avisos : []);
      setReproduciendo(false);
      setSrc({ url, n: gen });
      setEstado({ tipo: "cargando" });
    } catch (e) {
      if (!montada.current || gen !== generacion.current) return;
      setSrc(null);
      setEstado({
        tipo: "error",
        mensaje: sinRutas(e instanceof Error ? e.message : "No se pudo abrir la preview."),
      });
    }
  }, [sesion]);

  // Primera apertura inmediata; después, 400 ms tras cada guardado (`revision`) o recarga pedida.
  // `claveDisparada` evita la doble apertura del doble montaje de StrictMode.
  useEffect(() => {
    if (!coincide || !sesion || proyectoId === null) return;
    const clave = `${proyectoId}:${revision}:${recarga}`;
    if (claveDisparada.current === clave) return;
    const primera = claveDisparada.current === null;
    claveDisparada.current = clave;
    if (primera) void abrir();
    else sesion.programar(() => void abrir(), ESPERA_RECARGA_MS);
  }, [coincide, sesion, proyectoId, revision, recarga, abrir]);

  // Al desmontar, las respuestas en vuelo ya no se aplican (la sesión la cierra quien la creó).
  useEffect(() => {
    montada.current = true;
    return () => {
      montada.current = false;
    };
  }, []);

  const enviar = useCallback((orden: OrdenIframe) => enviarOrden(iframeRef.current?.contentWindow, orden), []);

  const pedirSeek = useCallback(
    (t: number) => {
      const max = duracionRef.current;
      const id = ++siguienteId.current;
      if (pendientes.current.size >= MAX_PENDIENTES) pendientes.current.clear();
      pendientes.current.add(id);
      enviar({ tipo: "seek", id, t: Math.min(Math.max(0, Number.isFinite(t) ? t : 0), max) });
    },
    [enviar],
  );

  useEffect(() => {
    const alMensaje = (e: MessageEvent) => {
      const ventana = iframeRef.current?.contentWindow;
      if (!ventana || e.source !== ventana) {
        descartados.current++; // no es nuestro iframe: se ignora y se cuenta
        iframeRef.current?.setAttribute("data-descartados", String(descartados.current));
        return;
      }
      if (!limitador.current.admitir(performance.now())) {
        descartados.current++;
        iframeRef.current?.setAttribute("data-descartados", String(descartados.current));
        return;
      }
      const m = validarMensajeIframe(e, ventana, pendientes.current, duracionRef.current);
      if (m === null) {
        descartados.current++;
        iframeRef.current?.setAttribute("data-descartados", String(descartados.current));
        return;
      }
      switch (m.tipo) {
        case "listo": {
          duracionRef.current = m.duracion;
          setDuracion(m.duracion);
          listoRef.current = true;
          setEstado({ tipo: "listo" });
          if (ultimoT.current > 0) pedirSeek(ultimoT.current);
          break;
        }
        case "seek-hecho":
          pendientes.current.delete(m.id);
          ultimoT.current = m.t;
          setTActual(m.t);
          break;
        case "error":
          pendientes.current.delete(m.id);
          break;
        case "tiempo":
          ultimoT.current = m.t;
          setTActual(m.t);
          setReproduciendo(m.reproduciendo);
          fijarTiempo(m.t);
          break;
      }
    };
    window.addEventListener("message", alMensaje);
    return () => window.removeEventListener("message", alMensaje);
  }, [pedirSeek]);

  // El cabezal del timeline manda: un salto manual lleva la preview a ese instante.
  useEffect(() => {
    if (!listoRef.current || estado.tipo !== "listo") return;
    if (Math.abs(tiempo - ultimoT.current) <= 0.05) return;
    ultimoT.current = tiempo;
    setTActual(tiempo);
    pedirSeek(tiempo);
  }, [tiempo, estado.tipo, pedirSeek]);

  // Escala del lienzo 1080×1920 al hueco disponible.
  useEffect(() => {
    const el = escenarioRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const medir = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) setEscala(Math.min(width / ANCHO, height / ALTO));
    };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const alternar = () => {
    if (estado.tipo !== "listo") return;
    enviar({ tipo: reproduciendo ? "pause" : "play" });
  };

  if (!coincide) {
    return (
      <div className={s.preview}>
        <div className={s.escenario}>
          <div className={s.error} role="alert" data-testid="preview-error">
            No hay una sesión de preview para este proyecto.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.preview}>
      <div className={s.escenario} ref={escenarioRef}>
        <div className={s.caja} style={{ width: ANCHO * escala, height: ALTO * escala }}>
          {src && (
            <iframe
              key={src.n}
              ref={iframeRef}
              className={s.marco}
              style={{ transform: `scale(${escala})` }}
              data-testid="preview-marco"
              data-descartados="0"
              title="Vista previa del vídeo"
              src={src.url}
              sandbox="allow-scripts"
              allow="autoplay"
              referrerPolicy="no-referrer"
            />
          )}
          {(estado.tipo === "abriendo" || estado.tipo === "cargando") && (
            <div className={s.cargando} data-testid="preview-cargando" role="status">
              Preparando la preview…
            </div>
          )}
          {estado.tipo === "error" && (
            <div className={s.error} role="alert" data-testid="preview-error">
              {estado.mensaje}
            </div>
          )}
        </div>
      </div>
      {avisos.length > 0 && (
        <p className={s.aviso} data-testid="preview-aviso-fondo">
          {avisos.map((a) => sinRutas(aFrase(a) ?? "")).join(" ")}
        </p>
      )}
      <div className={s.controles}>
        <IconButton
          icon={reproduciendo ? Pause : Play}
          size="sm"
          variant="ghost"
          aria-label={reproduciendo ? "Pausar" : "Reproducir"}
          data-testid="preview-play"
          disabled={estado.tipo !== "listo"}
          onClick={alternar}
        />
        <span data-testid="preview-tiempo">
          {formato(tActual)} / {formato(duracion)}
        </span>
      </div>
    </div>
  );
}
