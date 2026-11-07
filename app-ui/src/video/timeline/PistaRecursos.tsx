/** Pista 2: la capa de recurso de cada escena (foto o clip del usuario) con su entrada y su
 *  salida dentro de la escena. Alt+flecha mueve la entrada y Mayús+flecha la salida (0,25 s). */
import { memo, type KeyboardEvent } from "react";
import { editar, fijarTiempo, seleccionar, useEditor } from "../../state/editor";
import { cx } from "../../ui/cx";
import { tiempoAX, type Disposicion } from "./geometria";
import s from "./Timeline.module.css";

const PASO = 0.25;

interface ClipProps {
  escenaId: string;
  etiqueta: string;
  modo: string;
  inicio: number;
  ancho: number;
  segundos: number;
  activa: boolean;
  entrada: number;
  salida: number;
  duracion: number;
}

function ajustar(escenaId: string, campo: "entrada" | "salida", delta: number, duracion: number) {
  editar((p) => {
    const c = p.escenas.find((e) => e.id === escenaId)?.capa;
    if (!c) return;
    const fin = c.salida > c.entrada ? c.salida : duracion;
    if (campo === "entrada") c.entrada = Math.min(Math.max(0, c.entrada + delta), fin - PASO);
    else c.salida = Math.min(Math.max(c.entrada + PASO, fin + delta), duracion);
  });
}

const ClipRecurso = memo(function ClipRecurso({ escenaId, etiqueta, modo, inicio, ancho, segundos, activa, entrada, salida, duracion }: ClipProps) {
  const alTeclar = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const delta = e.key === "ArrowLeft" ? -PASO : PASO;
    if (e.altKey) ajustar(escenaId, "entrada", delta, duracion);
    else if (e.shiftKey) ajustar(escenaId, "salida", delta, duracion);
    else return;
    e.preventDefault();
  };
  return (
    <button
      type="button"
      className={cx(s.clip, s.clipRecurso, activa && s.activo)}
      style={{ left: inicio, width: ancho }}
      data-testid={`clip-recurso-${escenaId}`}
      aria-pressed={activa}
      aria-label={`Recurso de la escena, ${modo === "detras" ? "detrás" : "encima"}, de ${entrada.toFixed(2)} a ${salida.toFixed(2)} s. Alt y flechas mueven la entrada, Mayús y flechas la salida.`}
      title={etiqueta}
      onKeyDown={alTeclar}
      onClick={() => {
        seleccionar(escenaId);
        fijarTiempo(segundos);
      }}
    >
      <span className={s.texto}>{etiqueta}</span>
    </button>
  );
});

export function PistaRecursos({ layout }: { layout: Disposicion }) {
  const proyecto = useEditor((e) => e.proyecto);
  const seleccion = useEditor((e) => e.seleccion);
  if (!proyecto) return null;
  const nombres = new Map(proyecto.recursos.map((r) => [r.id, r.nombreOriginal]));
  return (
    <div className={s.pista} data-testid="pista-recursos">
      {proyecto.escenas.map((e, i) => {
        if (!e.capa) return null;
        const c = layout.escenas[i];
        const dur = c.fin - c.inicio;
        const entrada = Math.min(Math.max(0, e.capa.entrada), dur);
        const salida = e.capa.salida > entrada ? Math.min(e.capa.salida, dur) : dur;
        return (
          <ClipRecurso
            key={e.id}
            escenaId={e.id}
            etiqueta={nombres.get(e.capa.recursoId) ?? e.capa.recursoId}
            modo={e.capa.modo}
            inicio={tiempoAX(c.inicio + entrada)}
            ancho={Math.max(tiempoAX(salida - entrada), 12)}
            segundos={c.inicio}
            activa={seleccion === e.id}
            entrada={entrada}
            salida={salida}
            duracion={dur}
          />
        );
      })}
    </div>
  );
}
