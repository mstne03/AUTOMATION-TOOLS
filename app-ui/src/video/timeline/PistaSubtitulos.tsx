/** Pista 5: subtítulos por líneas. Corregir palabras (`correcciones` por índice global de palabra)
 *  y cortes de línea (`cortes`). Todo texto, el del guion y las correcciones, se pinta como texto. */
import { Merge, Split } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { editar, useEditor } from "../../state/editor";
import { Button } from "../../ui";
import { cx } from "../../ui/cx";
import { cortesEfectivos, lineasSubtitulos, palabrasProyecto, tiempoAX, type Disposicion, type LineaSubtitulo } from "./geometria";
import s from "./Timeline.module.css";

/** Tope de una palabra corregida (el motor limita toda cadena). */
const MAX_PALABRA = 80;

interface ClipProps {
  indice: number;
  texto: string;
  inicio: number;
  ancho: number;
  activa: boolean;
  alElegir: (i: number) => void;
}

const ClipSubtitulo = memo(function ClipSubtitulo({ indice, texto, inicio, ancho, activa, alElegir }: ClipProps) {
  return (
    <button
      type="button"
      className={cx(s.clip, s.clipSubtitulo, activa && s.activo)}
      style={{ left: inicio, width: ancho }}
      data-testid={`clip-subtitulo-${indice}`}
      aria-pressed={activa}
      title={texto}
      onClick={() => alElegir(indice)}
    >
      <span className={s.texto}>{texto}</span>
    </button>
  );
});

function guardarCortes(cortes: number[]) {
  editar((p) => {
    p.subtitulos.cortes = [...new Set(cortes)].sort((a, b) => a - b);
  });
}

function EdicionLinea({ linea, haySiguiente }: { linea: LineaSubtitulo; haySiguiente: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const texto = linea.palabras.join(" ");

  // Deshacer o rehacer cambian el texto por fuera: se refleja si el usuario no está escribiendo.
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el) el.value = texto;
  }, [texto]);

  const confirmar = () => {
    const nuevas = (ref.current?.value ?? "").split(/\s+/).filter(Boolean);
    if (nuevas.length !== linea.palabras.length) {
      setError("Mantén el mismo número de palabras. Para repartirlas en dos líneas usa «Dividir».");
      return;
    }
    setError("");
    editar((p) => {
      const por = new Map(p.subtitulos.correcciones.map((c) => [c.indice, c.texto]));
      linea.originales.forEach((orig, j) => {
        const nueva = nuevas[j].slice(0, MAX_PALABRA);
        if (nueva === orig) por.delete(linea.desde + j);
        else por.set(linea.desde + j, nueva);
      });
      const lista = [...por].map(([indice, t]) => ({ indice, texto: t })).sort((a, b) => a.indice - b.indice);
      if (JSON.stringify(lista) !== JSON.stringify(p.subtitulos.correcciones)) p.subtitulos.correcciones = lista;
    });
  };

  const dividir = () => {
    const el = ref.current;
    if (!el) return;
    const k = el.value.slice(0, el.selectionStart ?? 0).split(/\s+/).filter(Boolean).length;
    if (k < 1 || k >= linea.palabras.length) {
      setError("Coloca el cursor entre dos palabras de la línea para dividirla.");
      return;
    }
    setError("");
    const p = useEditor.getState().proyecto!;
    guardarCortes([...cortesEfectivos(p, palabrasProyecto(p)), linea.desde + k]);
  };

  const unir = () => {
    const p = useEditor.getState().proyecto!;
    const siguiente = linea.desde + linea.palabras.length;
    guardarCortes(cortesEfectivos(p, palabrasProyecto(p)).filter((c) => c !== siguiente));
  };

  return (
    <div className={s.edicion}>
      <input
        ref={ref}
        className={s.campoTexto}
        defaultValue={texto}
        aria-label={`Texto de la línea ${linea.indice + 1}`}
        data-testid="subtitulo-texto"
        onChange={() => setError("")}
        onBlur={confirmar}
        onKeyDown={(e) => {
          if (e.key === "Enter") confirmar();
        }}
      />
      <Button size="sm" variant="ghost" icon={Split} data-testid="subtitulo-dividir" onClick={dividir}>
        Dividir
      </Button>
      <Button size="sm" variant="ghost" icon={Merge} data-testid="subtitulo-unir" disabled={!haySiguiente} onClick={unir}>
        Unir con la siguiente
      </Button>
      {error && (
        <p className={s.error} role="alert" data-testid="subtitulo-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function PistaSubtitulos({ layout }: { layout: Disposicion }) {
  const proyecto = useEditor((e) => e.proyecto);
  const [elegida, setElegida] = useState<number | null>(null);
  const lineas = useMemo(() => (proyecto ? lineasSubtitulos(proyecto, layout) : []), [proyecto, layout]);
  const linea = elegida !== null ? lineas[elegida] : undefined;
  return (
    <div className={s.pistaAlta} data-testid="pista-subtitulos">
      <div className={s.pista}>
        {lineas.map((l) => (
          <ClipSubtitulo
            key={l.indice}
            indice={l.indice}
            texto={l.palabras.join(" ")}
            inicio={tiempoAX(l.inicio)}
            ancho={Math.max(tiempoAX(l.fin - l.inicio), 12)}
            activa={elegida === l.indice}
            alElegir={setElegida}
          />
        ))}
      </div>
      {linea && <EdicionLinea key={linea.indice} linea={linea} haySiguiente={linea.indice < lineas.length - 1} />}
    </div>
  );
}
