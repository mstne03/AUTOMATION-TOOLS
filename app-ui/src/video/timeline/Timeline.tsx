/** Timeline de cinco pistas (D6): escenas, recursos, voz, música y subtítulos sobre una misma
 *  escala de tiempo. Lee el store del editor sin props; toda edición pasa por `editar()` (deshacer y
 *  rehacer funcionan) y nada gasta voz sin el diálogo `voz-confirmar` (I10). */
import { useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { Link } from "react-router";
import { fijarTiempo, useEditor } from "../../state/editor";
import { Button, Dialog } from "../../ui";
import { PX_POR_SEGUNDO, planificar, tiempoAX, xATiempo } from "./geometria";
import { ControlesMusica, PistaMusica } from "./PistaMusica";
import { PistaEscenas } from "./PistaEscenas";
import { PistaRecursos } from "./PistaRecursos";
import { PistaSubtitulos } from "./PistaSubtitulos";
import { PistaVoz } from "./PistaVoz";
import s from "./Timeline.module.css";
import { useCosteVoz, useFormaVoz, useGastoVoz, useQuitarSilencios } from "./useVoz";

const MARGEN_FINAL = 48;
const PASO_FINO = 0.1;
const PASO_GRUESO = 1;
const redondear = (n: number) => Math.round(n * 1000) / 1000;

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

function Regla({ total }: { total: number }) {
  const tiempo = useEditor((e) => e.tiempo);
  const carril = useRef<HTMLDivElement>(null);
  const arrastrando = useRef(false);
  const marcas = Array.from({ length: Math.floor(total / 5) + 1 }, (_, i) => i * 5);

  const desdePuntero = (e: PointerEvent<HTMLDivElement>) => {
    const r = carril.current?.getBoundingClientRect();
    if (r) fijarTiempo(redondear(Math.min(total, xATiempo(e.clientX - r.left))));
  };
  const alTeclar = (e: KeyboardEvent<HTMLDivElement>) => {
    const paso = e.shiftKey ? PASO_GRUESO : PASO_FINO;
    let nuevo: number;
    if (e.key === "ArrowRight") nuevo = tiempo + paso;
    else if (e.key === "ArrowLeft") nuevo = tiempo - paso;
    else if (e.key === "Home") nuevo = 0;
    else if (e.key === "End") nuevo = total;
    else return;
    e.preventDefault();
    fijarTiempo(redondear(Math.min(total, Math.max(0, nuevo))));
  };
  const acotado = Math.min(total, tiempo);
  return (
    <div
      ref={carril}
      className={s.regla}
      role="slider"
      tabIndex={0}
      data-testid="timeline-regla"
      aria-label="Posición del cabezal"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.round(total * 10) / 10}
      aria-valuenow={Math.round(acotado * 10) / 10}
      aria-valuetext={mmss(acotado)}
      onKeyDown={alTeclar}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        arrastrando.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        desdePuntero(e);
      }}
      onPointerMove={(e) => arrastrando.current && desdePuntero(e)}
      onPointerUp={() => (arrastrando.current = false)}
      onPointerCancel={() => (arrastrando.current = false)}
    >
      {marcas.map((m) => (
        <span key={m} className={s.marca} style={{ left: tiempoAX(m) }}>
          {mmss(m)}
        </span>
      ))}
    </div>
  );
}

function Cabezal({ total }: { total: number }) {
  const tiempo = useEditor((e) => e.tiempo);
  return <div className={s.cabezal} data-testid="timeline-cabezal" aria-hidden="true" style={{ transform: `translateX(${tiempoAX(Math.min(tiempo, total))}px)` }} />;
}

export function Timeline() {
  const proyecto = useEditor((e) => e.proyecto);
  const id = proyecto?.id;
  const forma = useFormaVoz(id);
  const coste = useCosteVoz(id);
  const voz = useGastoVoz();
  const silencios = useQuitarSilencios();
  const layout = useMemo(() => (proyecto ? planificar(proyecto, forma.data?.segundos) : null), [proyecto, forma.data?.segundos]);
  const pendientes = useMemo(() => new Set(coste.data?.pendientes ?? []), [coste.data]);

  if (!proyecto || !layout) return null;
  const ancho = tiempoAX(layout.total) + MARGEN_FINAL;
  const alDia = !!coste.data && coste.data.pendientes.length === 0;

  return (
    <section className={s.raiz} data-testid="timeline" aria-label="Línea de tiempo" style={{ ["--ancho-timeline" as string]: `${ancho}px`, ["--px-segundo" as string]: String(PX_POR_SEGUNDO) }}>
      <div className={s.rejilla}>
        <div className={s.fila}>
          <div className={s.etiqueta} />
          <div className={s.carril}>
            <Regla total={layout.total} />
          </div>
        </div>
        <div className={s.fila}>
          <div className={s.etiqueta}>Escenas</div>
          <div className={s.carril}>
            <PistaEscenas layout={layout} />
          </div>
        </div>
        <div className={s.fila}>
          <div className={s.etiqueta}>Recursos</div>
          <div className={s.carril}>
            <PistaRecursos layout={layout} />
          </div>
        </div>
        <div className={s.fila}>
          <div className={s.etiqueta}>
            <span>Voz</span>
            <Button size="sm" variant="secondary" data-testid="voz-generar" disabled={alDia} onClick={() => void voz.pedir()}>
              Generar voz
            </Button>
            <span className={s.coste} data-testid="voz-coste" aria-live="polite">
              {coste.data ? (alDia ? "Voz al día" : `${coste.data.caracteres} caracteres pendientes`) : ""}
            </span>
            {voz.sinClave && (
              <p className={s.aviso} role="alert" data-testid="voz-sin-clave">
                Falta la clave de ElevenLabs. <Link to="/ajustes">Añádela en Ajustes</Link>.
              </p>
            )}
          </div>
          <div className={s.carril}>
            <PistaVoz layout={layout} picos={forma.data?.picos} pendientes={pendientes} ocupadas={silencios.ocupadas} alRegenerar={(f) => void voz.pedir([f])} alQuitarSilencios={(f) => void silencios.quitar(f)} />
          </div>
        </div>
        <div className={s.fila}>
          <div className={s.etiqueta}>
            <span>Música</span>
            <ControlesMusica total={layout.total} />
          </div>
          <div className={s.carril}>
            <PistaMusica layout={layout} />
          </div>
        </div>
        <div className={s.fila}>
          <div className={s.etiqueta}>Subtítulos</div>
          <div className={s.carril}>
            <PistaSubtitulos layout={layout} />
          </div>
        </div>
        <div className={s.capaCabezal}>
          <Cabezal total={layout.total} />
        </div>
      </div>
      <Dialog
        open={!!voz.gasto}
        onOpenChange={(abierto) => {
          if (!abierto && !voz.enviando) voz.cerrar();
        }}
        title={voz.gasto?.frases ? "Regenerar esta frase" : "Generar la voz"}
        footer={
          <>
            <Button variant="ghost" data-testid="voz-confirmar-cancelar" disabled={voz.enviando} onClick={voz.cerrar}>
              Cancelar
            </Button>
            <Button variant="primary" data-testid="voz-confirmar-ok" loading={voz.enviando} onClick={() => void voz.confirmar()}>
              Confirmar y generar
            </Button>
          </>
        }
      >
        <div data-testid="voz-confirmar" className={s.confirmar}>
          {voz.gasto?.cambio && <p role="alert">El coste ha cambiado desde que lo viste. Revisa la cifra y confirma de nuevo.</p>}
          <p>
            Se facturarán <strong data-testid="voz-confirmar-coste">{voz.gasto?.caracteres}</strong> caracteres a tu cuenta de ElevenLabs con la voz «{voz.gasto?.voz}».
          </p>
        </div>
      </Dialog>
    </section>
  );
}
