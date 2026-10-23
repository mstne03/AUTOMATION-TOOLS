import s from "./Progress.module.css";

export interface ProgressProps {
  /** 0–1. Sin valor, barra indeterminada. */
  value?: number;
  /** Texto visible (y nombre accesible) de la barra. */
  label: string;
  /** Línea pequeña debajo: "48 MB de 114 MB · quedan ~40 s". */
  detail?: string;
}

export function Progress({ value, label, detail }: ProgressProps) {
  const pct = value === undefined ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className={s.caja}>
      <div className={s.cabecera}>
        <span>{label}</span>
        {pct !== undefined && <span className={s.valor}>{pct} %</span>}
      </div>
      <div className={s.pista} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        {/* ancho dinámico: único estilo inline permitido (no se puede expresar con una clase) */}
        <div className={pct === undefined ? s.indeterminada : s.relleno} style={pct === undefined ? undefined : { width: `${pct}%` }} />
      </div>
      {detail && <span className={s.detalle}>{detail}</span>}
    </div>
  );
}
