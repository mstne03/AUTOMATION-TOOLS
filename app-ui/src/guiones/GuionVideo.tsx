/** Guiones → Escribir, formato Vídeo (SPEC-video.md D5): edita el guion de escenas que produjo el
 *  modelo, lo guarda en el servidor y crea el proyecto. Todo lo que viene del modelo o del servidor
 *  se pinta como texto (nunca HTML) y nada se envía sin un clic del usuario. La UI no valida por el
 *  motor: `POST /video/guiones` decide y sus errores se muestran tal cual (T9). */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowDown, ArrowUp, Clapperboard, RotateCcw, Save, Trash2 } from "lucide-react";
import { useNavigate } from "react-router";
import { ApiError } from "../api/client";
import { useClient } from "../api/context";
import { useGuionesVideo } from "../api/queries";
import { crearVideo, editarCabeceraVideo, editarEscenaVideo, empezarDeNuevo, guardarGuionVideo, moverEscenaVideo, useGuiones } from "../state/guiones";
import { Button, Chip, ConfirmDialog, Field, IconButton, Input, Select, Textarea } from "../ui";
import { erroresServidor } from "./modelo";
import s from "./Guiones.module.css";

const TIPOS: { value: string; label: string }[] = [
  { value: "cartel", label: "Cartel" },
  { value: "cifra", label: "Cifra" },
  { value: "barras", label: "Barras" },
  { value: "mapa", label: "Mapa" },
  { value: "titulo3d", label: "Título 3D" },
];

export function GuionVideo() {
  const client = useClient();
  const navegar = useNavigate();
  const qc = useQueryClient();
  const e = useGuiones((st) => st.escribir);
  const g = e.guionVideo;
  if (!g) return null;

  const guardar = async () => {
    if (await guardarGuionVideo(client)) void qc.invalidateQueries({ queryKey: ["video", "guiones"] });
  };
  const crear = async () => {
    const id = await crearVideo(client);
    if (!id) return;
    void qc.invalidateQueries({ queryKey: ["video"] });
    navegar(`/video/${encodeURIComponent(id)}`);
  };

  return (
    <section className={s.tarjeta} data-testid="guion-video" aria-labelledby="guion-video-h">
      <div className={s.tarjetaCabecera}>
        <h2 id="guion-video-h" className={s.h2}>
          Guion de vídeo
        </h2>
        <Button size="sm" variant="ghost" icon={RotateCcw} disabled={e.videoOcupado} onClick={() => empezarDeNuevo("escribir")}>
          Empezar de nuevo
        </Button>
      </div>
      <Field label="Título">
        <Input data-testid="guion-video-titulo" value={g.titulo} onChange={(ev) => editarCabeceraVideo({ titulo: ev.target.value })} />
      </Field>
      <Field label="Gancho">
        <Input data-testid="guion-video-gancho" value={g.gancho} onChange={(ev) => editarCabeceraVideo({ gancho: ev.target.value })} />
      </Field>

      <h2 className={s.h2}>Escenas</h2>
      <ol className={s.bloques} data-testid="guion-video-escenas">
        {g.escenas.map((esc, i) => {
          const tipos = TIPOS.some((t) => t.value === esc.tipo) ? TIPOS : [...TIPOS, { value: esc.tipo, label: esc.tipo }];
          return (
            <li key={i} className={s.bloque} data-testid="guion-video-escena">
              <div className={s.fila}>
                <Field label={`Tipo de la escena ${i + 1}`} className={s.crece}>
                  <Select data-testid="guion-video-tipo" value={esc.tipo} onChange={(ev) => editarEscenaVideo(i, { tipo: ev.target.value })}>
                    {tipos.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <IconButton size="sm" icon={ArrowUp} aria-label={`Subir la escena ${i + 1}`} data-testid="guion-video-subir" disabled={i === 0} onClick={() => moverEscenaVideo(i, -1)} />
                <IconButton size="sm" icon={ArrowDown} aria-label={`Bajar la escena ${i + 1}`} data-testid="guion-video-bajar" disabled={i === g.escenas.length - 1} onClick={() => moverEscenaVideo(i, 1)} />
              </div>
              {esc.frases.map((f, j) => (
                <Textarea
                  key={j}
                  rows={2}
                  data-testid="guion-video-frase"
                  aria-label={`Frase ${j + 1} de la escena ${i + 1}`}
                  value={f}
                  onChange={(ev) => editarEscenaVideo(i, { frases: esc.frases.map((x, k) => (k === j ? ev.target.value : x)) })}
                />
              ))}
              {esc.recurso && (
                <p className={s.nota} data-testid="guion-video-recurso">
                  <Chip tone="info">{esc.recurso.tipo === "clip" ? "Clip" : "Foto"}</Chip> {esc.recurso.queDebeSalir}
                </p>
              )}
            </li>
          );
        })}
      </ol>

      {e.videoAvisos.length > 0 && (
        <ul className={s.aviso} data-testid="guion-video-avisos">
          {e.videoAvisos.map((a, i) => (
            <li key={i}>{a.mensaje}</li>
          ))}
        </ul>
      )}
      {e.videoErrores.length > 0 && (
        <ul className={s.aviso} data-testid="guion-video-errores" role="alert">
          {e.videoErrores.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      )}

      <div className={s.acciones}>
        <Button icon={Save} data-testid="guion-video-guardar" disabled={e.videoOcupado} onClick={() => void guardar()}>
          {e.videoGuardadoId ? "Guardado" : "Guardar guion"}
        </Button>
        <Button variant="primary" icon={Clapperboard} data-testid="guion-video-crear" disabled={e.videoOcupado} onClick={() => void crear()}>
          Crear vídeo
        </Button>
      </div>
    </section>
  );
}

/** Guiones de vídeo ya guardados en el servidor. */
export function GuionesGuardados() {
  const client = useClient();
  const qc = useQueryClient();
  const lista = useGuionesVideo();
  const [aBorrar, setABorrar] = useState<{ id: string; titulo: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!lista.data?.length) return null;
  const borrar = async (id: string) => {
    setError(null);
    try {
      await client.videoGuionBorrar(id);
    } catch (e) {
      const lineas = e instanceof ApiError ? erroresServidor(e.detail) : [e instanceof Error ? e.message : "Error desconocido."];
      setError(`No se pudo borrar el guion: ${lineas[0] ?? "error desconocido"}`);
    } finally {
      void qc.invalidateQueries({ queryKey: ["video", "guiones"] });
    }
  };
  return (
    <section className={s.panel} data-testid="guiones-guardados" aria-labelledby="guiones-guardados-t">
      <span id="guiones-guardados-t" className={s.panelTitulo}>
        Guiones guardados
      </span>
      <ul className={s.fuentes}>
        {lista.data.map((gu) => (
          <li key={gu.id} className={s.guardado} data-testid={`guion-guardado-${gu.id}`}>
            <span className={s.guardadoTitulo}>{gu.titulo}</span>
            <IconButton size="sm" icon={Trash2} aria-label={`Borrar el guion ${gu.titulo}`} data-testid={`guion-guardado-borrar-${gu.id}`} onClick={() => setABorrar({ id: gu.id, titulo: gu.titulo })} />
          </li>
        ))}
      </ul>
      {error && (
        <p className={s.aviso} role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={aBorrar !== null}
        onOpenChange={(a) => !a && setABorrar(null)}
        title="¿Borrar este guion?"
        description={aBorrar?.titulo}
        confirmLabel="Borrar"
        tone="danger"
        onConfirm={() => {
          if (aBorrar) return borrar(aBorrar.id);
        }}
      />
    </section>
  );
}
