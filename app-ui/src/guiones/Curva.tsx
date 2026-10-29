/** Curva de retención en SVG propio (sin librería de gráficos). El trazo se estira al ancho
 *  disponible (`preserveAspectRatio="none"` y trazos que no escalan) y las etiquetas de los ejes
 *  son HTML encima, para que el texto no se deforme. */
import s from "./Guiones.module.css";
import { mmss, type Retencion } from "./modelo";

const W = 1000;
const H = 200;

export function Curva({ r }: { r: Retencion }) {
  const maxY = Math.max(1, ...r.curve.map((p) => p.watch));
  const x = (t: number) => (t / r.duration_s) * W;
  const y = (w: number) => H - (w / maxY) * H;
  const puntos = r.curve.map((p) => `${x(p.t).toFixed(1)},${y(p.watch).toFixed(1)}`).join(" ");
  const ancho = (a: number, b: number) => Math.max(x(b) - x(a), 4);

  return (
    <figure className={s.curva}>
      <div className={s.curvaLeyenda}>
        <span>Datos de YouTube Analytics</span>
        <span>
          <i className={`${s.muestra} ${s.muestraCaida}`} aria-hidden /> Caídas
        </span>
        <span>
          <i className={`${s.muestra} ${s.muestraPico}`} aria-hidden /> Se vuelve a ver
        </span>
      </div>
      <div className={s.curvaArea}>
        <svg data-testid="diag-curva" width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Curva de retención">
          {[0.5, 1].map((w) => (
            <line key={w} className={s.rejilla} x1={0} x2={W} y1={y(w)} y2={y(w)} vectorEffect="non-scaling-stroke" />
          ))}
          {r.drops.map((m, i) => (
            <rect key={`c${i}`} data-testid="curva-caida" className={s.bandaCaida} x={x(m.t_start)} width={ancho(m.t_start, m.t_end)} y={0} height={H} />
          ))}
          {r.spikes.map((m, i) => (
            <rect key={`p${i}`} data-testid="curva-pico" className={s.bandaPico} x={x(m.t_start)} width={ancho(m.t_start, m.t_end)} y={0} height={H} />
          ))}
          <line className={s.ventanaGancho} x1={x(r.intro_window_s)} x2={x(r.intro_window_s)} y1={0} y2={H} vectorEffect="non-scaling-stroke" />
          <polyline className={s.linea} points={puntos} vectorEffect="non-scaling-stroke" />
        </svg>
        {[1, 0.5, 0].map((w) => (
          <span key={w} className={s.curvaY} style={{ top: `${(1 - w / maxY) * 100}%` }} aria-hidden>
            {Math.round(w * 100)} %
          </span>
        ))}
      </div>
      <div className={s.curvaX} aria-hidden>
        <span>0:00</span>
        <span>{mmss(r.duration_s / 2)}</span>
        <span>{mmss(r.duration_s)}</span>
      </div>
    </figure>
  );
}
