/** Pestaña «Perfil» (D8, fase 1): lista simple de perfiles con «Duplicar», y edición de paleta,
 *  fuente y voz del perfil en uso. El perfil se guarda en el servidor (PUT) y el proyecto solo
 *  guarda qué `perfilId` usa; tras guardar, el proyecto se marca como cambiado para que el
 *  autoguardado suba la revisión y la preview se recargue. La voz se escucha con una muestra de
 *  60 caracteres que gasta cuota de ElevenLabs: solo tras confirmar (I10, M-D3). Nunca `preview_url`. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { usePerfilesVideo } from "../../api/queries";
import { useClient } from "../../api/context";
import type { PerfilVideo } from "../../api/types";
import { esObjeto } from "../../json";
import { sinRutas } from "../../screens/MotorVideo";
import { editar, useEditor } from "../../state/editor";
import { Button, ConfirmDialog, Field, Input, Select } from "../../ui";
import s from "./Panel.module.css";

const CARACTERES_MUESTRA = 60;
const COLORES: { campo: string; etiqueta: string }[] = [
  { campo: "fondo", etiqueta: "Fondo" },
  { campo: "texto", etiqueta: "Texto" },
  { campo: "acento", etiqueta: "Acento" },
  { campo: "contorno", etiqueta: "Contorno" },
  { campo: "secundario", etiqueta: "Secundario" },
];
const FUENTES = ["Anton", "Inter Tight", "JetBrains Mono"];
const PERFIL_ID_RE = /^(defecto|p-[0-9a-f]{16})$/;

const mensaje = (e: unknown, defecto: string) => sinRutas(e instanceof Error ? e.message : defecto);
const texto = (v: unknown) => (typeof v === "string" ? v : "");

function CampoColor({ campo, etiqueta, valor, onCommit }: { campo: string; etiqueta: string; valor: string; onCommit: (v: string) => void }) {
  // Borrador local: se guarda al salir del campo, no en cada tecla (cada guardado recarga la preview).
  const [borrador, setBorrador] = useState(valor);
  return (
    <div data-testid={`perfil-color-${campo}`}>
      <Field label={etiqueta}>
        <Input mono value={borrador} maxLength={32} onChange={(e) => setBorrador(e.target.value)} onBlur={() => borrador !== valor && onCommit(borrador)} />
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
  const [confirmando, setConfirmando] = useState(false);
  const [muestra, setMuestra] = useState<string | null>(null);

  const lista = perfiles.data ?? [];
  const perfil = lista.find((p) => p.id === perfilId);
  const colores = perfil && esObjeto(perfil.colores) ? perfil.colores : {};
  const voz = perfil ? texto(perfil.voz) : "";
  const listaVoces = voces.data ?? [];

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

  const guardar = async (cambio: (p: PerfilVideo) => PerfilVideo) => {
    if (!perfil) return;
    setError(null);
    try {
      const guardado = await client.videoPerfilGuardar(perfil.id, cambio(structuredClone(perfil)));
      qc.setQueryData<PerfilVideo[]>(["video", "perfiles"], (l) => (l ?? []).map((x) => (x.id === perfil.id ? { ...x, ...guardado } : x)));
      // El perfil no vive en el proyecto: marcarlo como cambiado sube la revisión y recarga la preview.
      if (useEditor.getState().proyecto?.id === proyectoId) editar(() => {});
    } catch (e) {
      setError(mensaje(e, "No se pudo guardar el perfil."));
    }
  };

  const generarMuestra = async () => {
    setError(null);
    setMuestra(null);
    try {
      await client.videoVozMuestra(voz, CARACTERES_MUESTRA);
      setMuestra(`Muestra generada (${CARACTERES_MUESTRA} caracteres).`);
    } catch (e) {
      setError(mensaje(e, "No se pudo generar la muestra."));
    }
  };

  return (
    <div className={s.seccion} data-testid="panel-perfil">
      <Field label="Perfil del vídeo">
        <Select value={perfilId ?? ""} onChange={(e) => elegir(e.target.value)} data-testid="perfil-selector">
          {perfilId && !perfil && <option value={perfilId}>{perfilId}</option>}
          {lista.map((p) => (
            <option key={p.id} value={p.id}>
              {p.nombre ?? p.id}
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
            <Select value={texto(perfil.fuente)} onChange={(e) => void guardar((p) => ({ ...p, fuente: e.target.value }))} data-testid="perfil-fuente">
              {!FUENTES.includes(texto(perfil.fuente)) && <option value={texto(perfil.fuente)}>{texto(perfil.fuente)}</option>}
              {FUENTES.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Voz" help={voces.isError ? "No se pudieron cargar las voces (¿falta la clave de ElevenLabs?)." : undefined}>
            <Select value={voz} onChange={(e) => void guardar((p) => ({ ...p, voz: e.target.value }))} data-testid="perfil-voz">
              {voz && !listaVoces.some((v) => v.id === voz) && <option value={voz}>{voz}</option>}
              {listaVoces.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.nombre}
                </option>
              ))}
            </Select>
          </Field>
          <div className={s.fila}>
            <Button size="sm" disabled={!voz} data-testid="perfil-voz-escuchar" onClick={() => setConfirmando(true)}>
              Escuchar ({CARACTERES_MUESTRA} caracteres)
            </Button>
            {muestra && <span className={s.meta}>{muestra}</span>}
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirmando}
        onOpenChange={setConfirmando}
        title="Generar una muestra de la voz"
        description={`La muestra gasta ${CARACTERES_MUESTRA} caracteres de tu cuota de ElevenLabs. Se guarda en caché por voz, así que repetirla no vuelve a gastar. ¿Generarla?`}
        confirmLabel="Generar muestra"
        onConfirm={() => generarMuestra()}
      />
    </div>
  );
}
