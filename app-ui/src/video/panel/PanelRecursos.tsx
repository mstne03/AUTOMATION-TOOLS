/** Pestaña «Recursos»: fotos y clips del usuario (D9). El diálogo de ficheros es nativo
 *  (`importar_recurso`) y devuelve un `bandeja_id`, nunca una ruta (I6); la UI solo conoce ese id y
 *  el recurso que devuelve el servidor, que se valida antes de entrar al proyecto. Nombres y
 *  «qué debe salir» se pintan como texto (I1). */
import { invoke } from "@tauri-apps/api/core";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useClient } from "../../api/context";
import { sinRutas } from "../../screens/MotorVideo";
import { editar, seleccionar, useEditor } from "../../state/editor";
import { Button, Chip, IconButton } from "../../ui";
import { esObjeto } from "../../json";
import type { Recurso } from "../modelo";
import s from "./Panel.module.css";

const AVISO_DERECHOS =
  "No uses retransmisiones ni material sin licencia: las plataformas pueden bloquear o reclamar el vídeo (Content ID). La app no puede comprobar el origen de lo que añades; solo te lo recuerda.";
const BANDEJA_RE = /^[0-9a-f]{32}$/;
const RECURSO_ID_RE = /^r-[0-9a-f]{16}$/;
const MIN_FOTO = { ancho: 1080, alto: 1920 };

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Lector defensivo del recurso que devuelve el servidor. */
function leerRecurso(v: unknown): Recurso | null {
  if (!esObjeto(v)) return null;
  const { id, clase, ext, nombreOriginal, ancho, alto, duracion } = v;
  if (typeof id !== "string" || !RECURSO_ID_RE.test(id)) return null;
  if (clase !== "foto" && clase !== "clip" && clase !== "musica") return null;
  if (ext !== "jpg" && ext !== "png" && ext !== "webp" && ext !== "mp4" && ext !== "wav") return null;
  if (typeof nombreOriginal !== "string" || !num(ancho) || !num(alto) || !num(duracion)) return null;
  return { id, clase, ext, nombreOriginal, ancho, alto, duracion };
}

/** Añadir o borrar un recurso cambia el disco del servidor, que deshacer no puede revertir: una
 *  instantánea anterior reintroduciría un recurso borrado (inexistente) o dejaría huérfano uno
 *  añadido. Opción robusta: tras la operación se vacía el historial de deshacer/rehacer, y el
 *  panel lo avisa. Las ediciones anteriores siguen en el proyecto; solo dejan de poder deshacerse. */
function vaciarHistorial() {
  useEditor.setState({ historial: [], futuro: [] });
}

const mensaje = (e: unknown, defecto: string) => sinRutas(e instanceof Error ? e.message : typeof e === "string" ? e : defecto);

export function PanelRecursos() {
  const client = useClient();
  const proyectoId = useEditor((e) => e.proyecto?.id);
  const recursos = useEditor((e) => e.proyecto?.recursos);
  const escenas = useEditor((e) => e.proyecto?.escenas);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [borrando, setBorrando] = useState<ReadonlySet<string>>(new Set());
  const [avisos, setAvisos] = useState<Record<string, string[]>>({});

  const anadir = async (clase: "foto" | "clip") => {
    if (!proyectoId) return;
    setError(null);
    setOcupado(true);
    try {
      const bandeja = await invoke<string | null>("importar_recurso", { clase });
      if (bandeja == null) return; // diálogo cancelado
      if (typeof bandeja !== "string" || !BANDEJA_RE.test(bandeja)) throw new Error("El diálogo de ficheros devolvió un identificador no válido.");
      const r = await client.videoRecursoAnadir(proyectoId, bandeja, clase);
      const nuevo = leerRecurso(r.recurso);
      if (!nuevo) throw new Error("El servidor no devolvió el recurso añadido.");
      if (useEditor.getState().proyecto?.id !== proyectoId) return; // se cambió de proyecto mientras tanto
      editar((p) => {
        if (!p.recursos.some((x) => x.id === nuevo.id)) p.recursos.push(nuevo);
      });
      vaciarHistorial();
      const textos = Array.isArray(r.avisos) ? r.avisos.flatMap((a) => (esObjeto(a) && typeof a.mensaje === "string" ? [sinRutas(a.mensaje)] : [])) : [];
      setAvisos((a) => ({ ...a, [nuevo.id]: textos }));
    } catch (e) {
      setError(mensaje(e, "No se pudo añadir el recurso."));
    } finally {
      setOcupado(false);
    }
  };

  const borrar = async (rid: string) => {
    if (!proyectoId) return;
    if (borrando.has(rid)) return;
    setError(null);
    setBorrando((b) => new Set(b).add(rid));
    try {
      await client.videoRecursoBorrar(proyectoId, rid);
      if (useEditor.getState().proyecto?.id !== proyectoId) return;
      editar((p) => {
        p.recursos = p.recursos.filter((x) => x.id !== rid);
      });
      vaciarHistorial();
    } catch (e) {
      setError(mensaje(e, "No se pudo borrar el recurso."));
    } finally {
      setBorrando((b) => {
        const n = new Set(b);
        n.delete(rid);
        return n;
      });
    }
  };

  const pendientes = (escenas ?? []).flatMap((e, i) => (e.recursoPendiente ? [{ escena: e, n: i + 1, pedido: e.recursoPendiente }] : []));

  return (
    <div className={s.seccion} data-testid="panel-recursos">
      <p className={s.aviso} data-testid="recursos-aviso">
        {AVISO_DERECHOS}
      </p>
      <div className={s.fila}>
        <Button size="sm" loading={ocupado} data-testid="recursos-anadir-foto" onClick={() => void anadir("foto")}>
          Añadir foto
        </Button>
        <Button size="sm" loading={ocupado} data-testid="recursos-anadir-clip" onClick={() => void anadir("clip")}>
          Añadir clip
        </Button>
      </div>
      <p className={s.meta}>
        Añadir o borrar un recurso vacía el historial de deshacer.
      </p>
      {error && (
        <p className={s.error} role="alert" data-testid="recursos-error">
          {error}
        </p>
      )}
      {pendientes.length > 0 && (
        <div className={s.seccion} data-testid="recursos-pendientes">
          <h3 className={s.titulo}>Recursos que faltan</h3>
          <ul className={s.lista}>
            {pendientes.map(({ escena, n, pedido }) => (
              <li key={escena.id} className={s.item} data-testid={`recurso-pendiente-${escena.id}`}>
                <div className={s.itemFila}>
                  <Chip tone="write">Falta {pedido.tipo === "clip" ? "un clip" : "una foto"}</Chip>
                  <Button size="sm" variant="ghost" onClick={() => seleccionar(escena.id)}>
                    Ver escena {n}
                  </Button>
                </div>
                <span className={s.nombre}>{pedido.que_debe_salir}</span>
                <span className={s.meta}>
                  Mínimo {pedido.resolucion_minima.ancho}×{pedido.resolucion_minima.alto}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <h3 className={s.titulo}>Tus recursos</h3>
      {recursos && recursos.length > 0 ? (
        <ul className={s.lista} data-testid="recursos-lista">
          {recursos.map((r) => {
            const baja = r.clase === "foto" && (r.ancho < MIN_FOTO.ancho || r.alto < MIN_FOTO.alto);
            const textos = [...(baja ? [`Resolución baja (${r.ancho}×${r.alto}): se recomienda al menos ${MIN_FOTO.ancho}×${MIN_FOTO.alto}.`] : []), ...(avisos[r.id] ?? [])];
            return (
              <li key={r.id} className={s.item} data-testid={`recurso-${r.id}`}>
                <div className={s.itemFila}>
                  <span className={s.nombre}>{r.nombreOriginal}</span>
                  <IconButton icon={Trash2} size="sm" variant="ghost" aria-label={`Borrar ${r.nombreOriginal}`} data-testid={`recurso-borrar-${r.id}`} disabled={borrando.has(r.id)} onClick={() => void borrar(r.id)} />
                </div>
                <span className={s.meta}>
                  {r.clase === "foto" ? "Foto" : r.clase === "clip" ? "Clip" : "Música"} · {r.ancho}×{r.alto}
                  {r.duracion > 0 ? ` · ${r.duracion.toFixed(1)} s` : ""}
                </span>
                {textos.length > 0 && (
                  <div data-testid={`recurso-aviso-${r.id}`}>
                    {textos.map((t, i) => (
                      <p key={i} className={s.avisoItem}>
                        {t}
                      </p>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={s.vacio}>Todavía no has añadido recursos.</p>
      )}
    </div>
  );
}
