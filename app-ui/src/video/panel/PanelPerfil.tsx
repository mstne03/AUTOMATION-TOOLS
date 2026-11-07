/** Pestaña «Perfil» (D8, fase 1): lista simple de perfiles con «Duplicar», y edición de paleta,
 *  fuente y voz del perfil en uso. El perfil se guarda en el servidor (PUT) y el proyecto solo
 *  guarda qué `perfilId` usa. Los guardados del perfil se serializan: cada PUT parte del resultado
 *  del anterior, nunca de la copia en caché, para no pisar cambios. Guardar un perfil NO toca el
 *  historial de deshacer (el perfil vive en el servidor).
 *
 *  TODO(T17): recargar la preview tras guardar un perfil. `SesionPreview` (EditorPreview.ts) solo
 *  ofrece `abrir`/`programar`/`cerrar`; cuando `Preview.tsx` exponga cómo reabrir la preview, se
 *  llamará desde `guardar` (hoy no hay `editar(() => {})`: ensuciaba el historial).
 *
 *  «Escuchar» (D7) queda DESHABILITADO hasta que T11 fije la respuesta de `video_voz_muestra`
 *  (`videoVozMuestra` devuelve `Record<string, unknown>`, sin audio tipado): gastar cuota de
 *  ElevenLabs (I10, M-D3) sin poder oír la muestra no es aceptable. Nunca `preview_url`. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { usePerfilesVideo } from "../../api/queries";
import { useClient } from "../../api/context";
import type { PerfilVideo } from "../../api/types";
import { esObjeto } from "../../json";
import { sinRutas } from "../../screens/MotorVideo";
import { editar, useEditor } from "../../state/editor";
import { Button, Field, Input, Select } from "../../ui";
import s from "./Panel.module.css";

const AVISO_MUESTRA = "Disponible cuando el backend sirva la muestra (T11).";
const COLORES: { campo: string; etiqueta: string }[] = [
  { campo: "fondo", etiqueta: "Fondo" },
  { campo: "texto", etiqueta: "Texto" },
  { campo: "acento", etiqueta: "Acento" },
  { campo: "contorno", etiqueta: "Contorno" },
  { campo: "secundario", etiqueta: "Secundario" },
];
const FUENTES = ["Anton", "Inter Tight", "JetBrains Mono"];
/** Misma expresión que `COLOR_RE` del motor (`video-mcp-server/src/composicion.ts`). */
const COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const PERFIL_ID_RE = /^(defecto|p-[0-9a-f]{16})$/;

const mensaje = (e: unknown, defecto: string) => sinRutas(e instanceof Error ? e.message : defecto);
const texto = (v: unknown) => (typeof v === "string" ? v : "");

function CampoColor({ campo, etiqueta, valor, onCommit }: { campo: string; etiqueta: string; valor: string; onCommit: (v: string) => void }) {
  // Borrador local: se guarda al salir del campo, no en cada tecla (cada guardado recarga la preview).
  const [borrador, setBorrador] = useState(valor);
  const invalido = borrador !== "" && !COLOR_RE.test(borrador);
  return (
    <div data-testid={`perfil-color-${campo}`}>
      <Field label={etiqueta} error={invalido ? "Usa un color hexadecimal, p. ej. #1a2b3c." : undefined}>
        <Input
          mono
          value={borrador}
          maxLength={32}
          aria-invalid={invalido || undefined}
          onChange={(e) => setBorrador(e.target.value)}
          onBlur={() => borrador !== valor && COLOR_RE.test(borrador) && onCommit(borrador)}
        />
      </Field>
    </div>
  );
}

export function PanelPerfil() {
  const client = useClient();
  const qc = useQueryClient();
  const perfilId = useEditor((e) => e.proyecto?.perfilId);
  const proyectoId = useEditor((e) => e.proyecto?.id);
  const perfiles = usePerfilesVideo();
  const voces = useQuery({ queryKey: ["video", "voces"], queryFn: () => client.videoVoces(), retry: false });
  const [error, setError] = useState<string | null>(null);
  /** Cola de guardados (uno detrás de otro) y última versión conocida de cada perfil. */
  const cola = useRef<Promise<void>>(Promise.resolve());
  const pendientes = useRef(0);
  const ultimo = useRef(new Map<string, PerfilVideo>());

  const lista = perfiles.data ?? [];
  const perfil = lista.find((p) => p.id === perfilId);
  const colores = perfil && esObjeto(perfil.colores) ? perfil.colores : {};
  const voz = perfil ? texto(perfil.voz) : "";
  const listaVoces = (voces.data ?? []).filter((v) => typeof v.id === "string" && typeof v.nombre === "string");

  const elegir = (id: string) => {
    if (!PERFIL_ID_RE.test(id)) return;
    setError(null);
    editar((p) => {
      p.perfilId = id;
    });
  };

  const duplicar = async () => {
    if (!perfilId) return;
    setError(null);
    try {
      const nuevo = await client.videoPerfilDuplicar(perfilId);
      await qc.invalidateQueries({ queryKey: ["video", "perfiles"] });
      if (useEditor.getState().proyecto?.id !== proyectoId) return;
      if (typeof nuevo.id === "string") elegir(nuevo.id);
    } catch (e) {
      setError(mensaje(e, "No se pudo duplicar el perfil."));
    }
  };

  const guardar = (cambio: (p: PerfilVideo) => PerfilVideo): Promise<void> => {
    if (!perfil) return Promise.resolve();
    const id = perfil.id;
    // Un error anterior no se borra mientras haya guardados en curso.
    if (pendientes.current === 0) setError(null);
    pendientes.current++;
    const paso = async () => {
      try {
        // Parte de lo último que respondió el servidor para este perfil, no de la caché del render.
        const base = ultimo.current.get(id) ?? qc.getQueryData<PerfilVideo[]>(["video", "perfiles"])?.find((x) => x.id === id) ?? perfil;
        const guardado = await client.videoPerfilGuardar(id, cambio(structuredClone(base)));
        ultimo.current.set(id, { ...base, ...guardado });
        qc.setQueryData<PerfilVideo[]>(["video", "perfiles"], (l) => (l ?? []).map((x) => (x.id === id ? { ...x, ...guardado } : x)));
      } catch (e) {
        setError(mensaje(e, "No se pudo guardar el perfil."));
      } finally {
        pendientes.current--;
      }
    };
    cola.current = cola.current.then(paso);
    return cola.current;
  };

  return (
    <div className={s.seccion} data-testid="panel-perfil">
      <Field label="Perfil del vídeo">
        <Select value={perfilId ?? ""} onChange={(e) => elegir(e.target.value)} data-testid="perfil-selector">
          {perfilId && !perfil && <option value={perfilId}>{perfilId}</option>}
          {lista.map((p) => (
            <option key={p.id} value={p.id}>
              {texto(p.nombre) || p.id}
            </option>
          ))}
        </Select>
      </Field>
      <div className={s.fila}>
        <Button size="sm" disabled={!perfil} data-testid="perfil-duplicar" onClick={() => void duplicar()}>
          Duplicar
        </Button>
      </div>
      {perfiles.isError && (
        <p className={s.error} role="alert">
          {mensaje(perfiles.error, "No se pudieron cargar los perfiles.")}
        </p>
      )}
      {error && (
        <p className={s.error} role="alert" data-testid="perfil-error">
          {error}
        </p>
      )}
      {perfil && (
        <>
          <h3 className={s.titulo}>Paleta</h3>
          <div className={s.campos}>
            {COLORES.map((c) => (
              <CampoColor
                key={`${perfil.id}-${c.campo}-${texto(colores[c.campo])}`}
                campo={c.campo}
                etiqueta={c.etiqueta}
                valor={texto(colores[c.campo])}
                onCommit={(v) => void guardar((p) => ({ ...p, colores: { ...(esObjeto(p.colores) ? p.colores : {}), [c.campo]: v } }))}
              />
            ))}
          </div>
          <Field label="Fuente">
            <Select value={texto(perfil.fuente)} onChange={(e) => {
                const fuente = e.target.value; // capturar ahora: el guardado puede esperar en la cola
                void guardar((p) => ({ ...p, fuente }));
              }} data-testid="perfil-fuente">
              {!FUENTES.includes(texto(perfil.fuente)) && <option value={texto(perfil.fuente)}>{texto(perfil.fuente)}</option>}
              {FUENTES.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Voz" help={voces.isError ? "No se pudieron cargar las voces (¿falta la clave de ElevenLabs?)." : undefined}>
            <Select value={voz} onChange={(e) => {
                const nueva = e.target.value;
                void guardar((p) => ({ ...p, voz: nueva }));
              }} data-testid="perfil-voz">
              {voz && !listaVoces.some((v) => v.id === voz) && <option value={voz}>{voz}</option>}
              {listaVoces.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.nombre}
                </option>
              ))}
            </Select>
          </Field>
          <div className={s.fila}>
            <Button size="sm" disabled title={AVISO_MUESTRA} data-testid="perfil-voz-escuchar">
              Escuchar
            </Button>
            <span className={s.meta}>
              {AVISO_MUESTRA}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
