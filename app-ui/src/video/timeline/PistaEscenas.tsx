/** Pista 1: escenas en orden. Reordenar con el puntero (arrastrar) o con Alt+flecha; todo por
 *  `editar()`. Los textos de las escenas llegan del modelo y se pintan solo como texto. */
import { memo, useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { editar, fijarTiempo, seleccionar, useEditor } from "../../state/editor";
import type { EscenaBase } from "../modelo";
import { cx } from "../../ui/cx";
import { indiceDestino, reordenar, tiempoAX, type Disposicion } from "./geometria";
import s from "./Timeline.module.css";

const UMBRAL_ARRASTRE = 4;

export function etiquetaEscena(b: EscenaBase): string {
  switch (b.tipo) {
    case "cifra":
      return `${b.prefijo}${b.valor}${b.sufijo}`;
    case "barras":
      return b.titulo;
    case "mapa":
      return b.titulo ?? b.etiqueta ?? b.region;
    default:
      return b.texto;
  }
}

function moverEscena(desde: number, hasta: number) {
  editar((p) => {
    const orden = reordenar(
      p.escenas.map((e) => e.id),
      desde,
      hasta,
    );
    const porId = new Map(p.escenas.map((e) => [e.id, e]));
    p.escenas = orden.map((id) => porId.get(id)!);
  });
}

interface ClipProps {
  id: string;
  indice: number;
  total: number;
  tipo: string;
  etiqueta: string;
  inicio: number;
  /** Inicio en segundos, para llevar el cabezal al seleccionar. */
  segundos: number;
  ancho: number;
  activa: boolean;
  desplazamiento: number;
  arrastrando: boolean;
  alPulsar: (e: PointerEvent<HTMLButtonElement>, indice: number) => void;
  alMover: (e: PointerEvent<HTMLButtonElement>) => void;
  alSoltar: (e: PointerEvent<HTMLButtonElement>) => void;
}

const ClipEscena = memo(function ClipEscena({ id, indice, total, tipo, etiqueta, inicio, segundos, ancho, activa, desplazamiento, arrastrando, alPulsar, alMover, alSoltar }: ClipProps) {
  const alTeclar = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const destino = indice + (e.key === "ArrowLeft" ? -1 : 1);
    if (destino >= 0 && destino < total) moverEscena(indice, destino);
  };
  return (
    <button
      type="button"
      className={cx(s.clip, s.clipEscena, activa && s.activo, arrastrando && s.arrastrando)}
      style={{ left: inicio, width: ancho, transform: desplazamiento ? `translateX(${desplazamiento}px)` : undefined }}
      data-testid={`clip-escena-${id}`}
      aria-pressed={activa}
      aria-label={`Escena ${indice + 1} de ${total}: ${tipo}. Alt y flechas para moverla.`}
      title={etiqueta}
      onPointerDown={(e) => alPulsar(e, indice)}
      onPointerMove={alMover}
      onPointerUp={alSoltar}
      onPointerCancel={alSoltar}
      onKeyDown={alTeclar}
      onClick={() => {
        seleccionar(id);
        fijarTiempo(segundos);
      }}
    >
      <span className={s.num}>{indice + 1}</span>
      <span className={s.texto}>{etiqueta}</span>
    </button>
  );
});

export function PistaEscenas({ layout }: { layout: Disposicion }) {
  const escenas = useEditor((e) => e.proyecto?.escenas);
  const seleccion = useEditor((e) => e.seleccion);
  const [arrastre, setArrastre] = useState<{ indice: number; dx: number } | null>(null);
  const origen = useRef<{ indice: number; x: number; id: number; movido: boolean } | null>(null);
  const hizoArrastre = useRef(false);
  const anchos = layout.escenas.map((c) => tiempoAX(c.fin - c.inicio));

  const alPulsar = useCallback((e: PointerEvent<HTMLButtonElement>, indice: number) => {
    if (e.button !== 0) return;
    origen.current = { indice, x: e.clientX, id: e.pointerId, movido: false };
    hizoArrastre.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, []);
  const alMover = useCallback((e: PointerEvent<HTMLButtonElement>) => {
    const o = origen.current;
    if (!o || o.id !== e.pointerId) return;
    const dx = e.clientX - o.x;
    if (!o.movido && Math.abs(dx) < UMBRAL_ARRASTRE) return;
    o.movido = true;
    setArrastre({ indice: o.indice, dx });
  }, []);
  const alSoltar = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      const o = origen.current;
      origen.current = null;
      if (!o || o.id !== e.pointerId) return;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      setArrastre(null);
      if (!o.movido || e.type === "pointercancel") return;
      hizoArrastre.current = true;
      const c = layout.escenas[o.indice];
      const centro = tiempoAX(c.inicio) + anchos[o.indice] / 2 + (e.clientX - o.x);
      const destino = indiceDestino(centro, anchos);
      if (destino !== o.indice) moverEscena(o.indice, destino);
    },
    [layout],
  );

  if (!escenas) return null;
  return (
    <div
      className={s.pista}
      data-testid="pista-escenas"
      onClickCapture={(e) => {
        // Soltar tras arrastrar dispara un clic: no debe seleccionar.
        if (hizoArrastre.current) {
          hizoArrastre.current = false;
          e.stopPropagation();
        }
      }}
    >
      {escenas.map((e, i) => {
        const c = layout.escenas[i];
        return (
          <ClipEscena
            key={e.id}
            id={e.id}
            indice={i}
            total={escenas.length}
            tipo={e.base.tipo}
            etiqueta={etiquetaEscena(e.base)}
            inicio={tiempoAX(c.inicio)}
            segundos={c.inicio}
            ancho={anchos[i]}
            activa={seleccion === e.id}
            desplazamiento={arrastre?.indice === i ? arrastre.dx : 0}
            arrastrando={arrastre?.indice === i}
            alPulsar={alPulsar}
            alMover={alMover}
            alSoltar={alSoltar}
          />
        );
      })}
    </div>
  );
}
