/** Pista 3: voz por frases, con forma de onda (`/voz/forma`), regenerar una frase, quitar
 *  silencios y recorte ajustado a palabra (Mayús+flecha, o arrastrando el borde derecho).
 *  Regenerar abre siempre `voz-confirmar` con los caracteres del servidor (I10). */
import { Eraser, RefreshCw } from "lucide-react";
import { memo, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { editar, useEditor } from "../../state/editor";
import { Chip, IconButton } from "../../ui";
import { cx } from "../../ui/cx";
import { ajustarAPalabra, moverLimite, palabrasDeFrase, tiempoAX, xATiempo, type Disposicion } from "./geometria";
import s from "./Timeline.module.css";

const ALTO_ONDA = 36;
const RECORTE_MINIMO = 0.1;

export function Onda({ picos, ancho }: { picos: number[]; ancho: number }) {
  const d = useMemo(() => {
    const n = picos.length;
    if (!n || ancho <= 0) return "";
    const paso = ancho / n;
    let r = "";
    for (let i = 0; i < n; i++) {
      const v = Number.isFinite(picos[i]) ? Math.min(1, Math.max(0, picos[i])) : 0;
      const h = Math.max(1, v * ALTO_ONDA);
      r += `M${(i * paso + paso / 2).toFixed(1)} ${((ALTO_ONDA - h) / 2).toFixed(1)}v${h.toFixed(1)}`;
    }
    return r;
  }, [picos, ancho]);
  return (
    <svg className={s.onda} data-testid="voz-onda" width={ancho} height={ALTO_ONDA} viewBox={`0 0 ${ancho} ${ALTO_ONDA}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path d={d} className={s.ondaTrazo} />
    </svg>
  );
}

/** Aplica un nuevo final de recorte (en segundos del audio de la frase) por `editar()`. */
function recortarA(fraseId: string, fin: number) {
  editar((p) => {
    const f = p.frases.find((x) => x.id === fraseId);
    if (f) f.recorte = { inicio: f.recorte?.inicio ?? 0, fin };
  });
}

interface ClipProps {
  fraseId: string;
  texto: string;
  recorte: { inicio: number; fin: number } | undefined;
  audio: number;
  inicio: number;
  ancho: number;
  pendiente: boolean;
  ocupada: boolean;
  alRegenerar: (id: string) => void;
  alQuitarSilencios: (id: string) => void;
}

const ClipVoz = memo(function ClipVoz({ fraseId, texto, recorte, audio, inicio, ancho, pendiente, ocupada, alRegenerar, alQuitarSilencios }: ClipProps) {
  const palabras = useMemo(() => palabrasDeFrase(texto, { inicio: 0, fin: audio }), [texto, audio]);
  const [provisional, setProvisional] = useState<number | null>(null);
  const arrastre = useRef<{ x: number; fin: number; id: number } | null>(null);
  const fin = recorte?.fin ?? audio;
  const inicioRecorte = recorte?.inicio ?? 0;

  const alTeclar = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.shiftKey || e.altKey || e.target !== e.currentTarget) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const nuevo = moverLimite(fin, e.key === "ArrowLeft" ? -1 : 1, palabras, inicioRecorte + RECORTE_MINIMO, audio);
    if (nuevo !== null) recortarA(fraseId, nuevo);
  };
  const alPulsarBorde = (e: PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    arrastre.current = { x: e.clientX, fin, id: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const valorArrastre = (e: PointerEvent<HTMLSpanElement>) => {
    const a = arrastre.current!;
    const t = Math.min(audio, Math.max(inicioRecorte + RECORTE_MINIMO, a.fin + xATiempo(Math.abs(e.clientX - a.x)) * Math.sign(e.clientX - a.x)));
    return ajustarAPalabra(t, palabras);
  };
  const alMoverBorde = (e: PointerEvent<HTMLSpanElement>) => {
    if (arrastre.current?.id === e.pointerId) setProvisional(valorArrastre(e));
  };
  const alSoltarBorde = (e: PointerEvent<HTMLSpanElement>) => {
    const a = arrastre.current;
    if (!a || a.id !== e.pointerId) return;
    const nuevo = e.type === "pointercancel" ? null : valorArrastre(e);
    arrastre.current = null;
    setProvisional(null);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (nuevo !== null && Math.abs(nuevo - a.fin) > 1e-6) recortarA(fraseId, nuevo);
  };

  const anchoVisible = provisional === null ? ancho : Math.max(12, tiempoAX(provisional - inicioRecorte));
  return (
    <div
      role="group"
      tabIndex={0}
      className={cx(s.clip, s.clipVoz, pendiente && s.pendiente)}
      style={{ left: inicio, width: anchoVisible }}
      data-testid={`clip-voz-${fraseId}`}
      aria-label={`Frase: ${texto}. Mayús y flechas ajustan el final del recorte a una palabra.`}
      onKeyDown={alTeclar}
    >
      {pendiente && (
        <Chip tone="write" className={s.chipPend}>
          Pendiente
        </Chip>
      )}
      <span className={s.accionesClip}>
        <IconButton
          icon={RefreshCw}
          size="xs"
          variant="ghost"
          aria-label="Regenerar esta frase"
          data-testid={`voz-regenerar-${fraseId}`}
          onClick={() => alRegenerar(fraseId)}
        />
        <IconButton
          icon={Eraser}
          size="xs"
          variant="ghost"
          aria-label="Quitar silencios de esta frase"
          data-testid={`voz-quitar-silencios-${fraseId}`}
          disabled={ocupada}
          onClick={() => alQuitarSilencios(fraseId)}
        />
      </span>
      <span
        className={s.borde}
        aria-hidden="true"
        onPointerDown={alPulsarBorde}
        onPointerMove={alMoverBorde}
        onPointerUp={alSoltarBorde}
        onPointerCancel={alSoltarBorde}
      />
    </div>
  );
});

interface Props {
  layout: Disposicion;
  picos: number[] | undefined;
  pendientes: ReadonlySet<string>;
  ocupadas: ReadonlySet<string>;
  alRegenerar: (id: string) => void;
  alQuitarSilencios: (id: string) => void;
}

export function PistaVoz({ layout, picos, pendientes, ocupadas, alRegenerar, alQuitarSilencios }: Props) {
  const frases = useEditor((e) => e.proyecto?.frases);
  const escenas = useEditor((e) => e.proyecto?.escenas);
  if (!frases || !escenas) return null;
  const porId = new Map(frases.map((f) => [f.id, f]));
  return (
    <div className={s.pista} data-testid="pista-voz">
      {picos && picos.length > 0 && <Onda picos={picos} ancho={tiempoAX(layout.total)} />}
      {escenas.flatMap((e) =>
        e.fraseIds.map((fid) => {
          const f = porId.get(fid);
          const iv = layout.frases[fid];
          if (!f || !iv) return null;
          return (
            <ClipVoz
              key={fid}
              fraseId={fid}
              texto={f.texto}
              recorte={f.recorte}
              audio={layout.audio[fid]}
              inicio={tiempoAX(iv.inicio)}
              ancho={Math.max(tiempoAX(iv.fin - iv.inicio), 12)}
              pendiente={pendientes.has(fid)}
              ocupada={ocupadas.has(fid)}
              alRegenerar={alRegenerar}
              alQuitarSilencios={alQuitarSilencios}
            />
          );
        }),
      )}
    </div>
  );
}
