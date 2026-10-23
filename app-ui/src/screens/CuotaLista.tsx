/** Barras de cuota de la API de YouTube con nombres legibles (Canal y Ajustes › Avanzado). */
import { CUBOS, formatearNumero } from "../formato";
import s from "./CuotaLista.module.css";

export function CuotaLista({ buckets }: { buckets: Record<string, { used: number; limit: number }> }) {
  return (
    <>
      {Object.entries(buckets).map(([b, v]) => {
        const pct = v.limit ? v.used / v.limit : 0;
        const nombre = CUBOS[b]?.nombre ?? b;
        return (
          <div key={b} className={s.cuota} data-testid={`cuota-${b}`} data-nivel={pct >= 0.95 ? "critico" : pct >= 0.8 ? "alto" : "normal"}>
            <div className={s.fila}>
              <span>{nombre}</span>
              <span className={s.suave}>
                {formatearNumero(v.used)} de {formatearNumero(v.limit)}
              </span>
            </div>
            <div className={s.barra} role="progressbar" aria-label={nombre} aria-valuemin={0} aria-valuemax={v.limit} aria-valuenow={v.used}>
              {/* ancho dinámico: único estilo inline permitido */}
              <div className={s.relleno} style={{ width: `${Math.max(pct > 0 ? 1 : 0, Math.round(pct * 100))}%` }} />
            </div>
          </div>
        );
      })}
    </>
  );
}
