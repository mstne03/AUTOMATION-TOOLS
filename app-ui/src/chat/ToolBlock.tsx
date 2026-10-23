/** Pasos del agente (docs/pantallas.md → Chat → Tool): las tools consecutivas de un turno se agrupan
 *  en un bloque plegable ("2 pasos · … · 1 u de cuota"); cada paso es una fila con nombre legible,
 *  riesgo como chip y cuota. El JSON y el nombre técnico quedan tras "Ver detalles técnicos". */
import { Check, ChevronDown, CircleAlert, Clock, Loader } from "lucide-react";
import { useYoutubeTools } from "../api/queries";
import type { Job, Risk } from "../api/types";
import { useJobs } from "../state/jobs";
import { Chip, Mono } from "../ui";
import { ETIQUETA_RIESGO, infoTool } from "./herramientas";
import s from "./ToolBlock.module.css";
import { rutaResuelta, type BloqueTool } from "./turno";

export function estadoTool(b: BloqueTool): string {
  if (b.result) return b.result.is_error ? "error" : b.approval?.status === "rejected" ? "rechazada" : "hecho";
  if (b.job) {
    const pct = Math.round(b.job.progress * 100);
    if (b.job.status === "queued") return "en cola";
    if (b.job.status === "running") return `${b.job.kind === "upload" ? "subiendo" : "transcribiendo"} ${pct} %`;
    if (b.job.status === "failed") return "error";
    return "hecho";
  }
  if (b.approval) {
    if (b.approval.status === "pending") return "esperando aprobación";
    if (b.approval.status === "approved") return "aprobada";
    return "rechazada";
  }
  return "ejecutando";
}

/** El progreso llega por el sondeo del store de jobs; el job del stream puede ser más nuevo (job_finished). */
const masNuevo = (a: Job | undefined, b: Job | undefined) => (a && b ? (a.updated_at >= b.updated_at ? a : b) : (a ?? b));

function useBloqueVivo(original: BloqueTool): BloqueTool {
  const vivo = useJobs((st) => (original.job ? st.jobs[original.job.id] : undefined));
  const job = masNuevo(original.job, vivo);
  return job === original.job ? original : { ...original, job };
}

function IconoEstado({ estado }: { estado: string }) {
  if (estado === "hecho" || estado === "aprobada") return <Check aria-hidden className={s.ok} size="1.15em" />;
  if (estado === "error") return <CircleAlert aria-hidden className={s.fallo} size="1.15em" />;
  if (estado === "rechazada") return <CircleAlert aria-hidden className={s.suave} size="1.15em" />;
  if (estado === "esperando aprobación") return <Clock aria-hidden className={s.espera} size="1.15em" />;
  return <Loader aria-hidden className={s.gira} size="1.15em" />;
}

function riesgoDe(b: BloqueTool, tools: Record<string, { risk: Risk }> | undefined): Risk {
  return b.approval?.risk ?? tools?.[b.name]?.risk ?? "read";
}

export function PasoTool({ bloque: original }: { bloque: BloqueTool }) {
  const bloque = useBloqueVivo(original);
  const tools = useYoutubeTools().data;
  const estado = estadoTool(bloque);
  const info = infoTool(bloque.name);
  const riesgo = riesgoDe(bloque, tools);
  const cuota = tools?.[bloque.name]?.quota?.cost ?? bloque.approval?.quota?.cost;
  const ruta = rutaResuelta(bloque);
  return (
    <details className={s.paso} data-testid="bloque-tool" data-tool={bloque.name}>
      <summary className={s.fila}>
        <IconoEstado estado={estado} />
        <span className={s.nombre}>{info.etiqueta}</span>
        {riesgo !== "read" && <Chip tone={riesgo}>{ETIQUETA_RIESGO[riesgo]}</Chip>}
        <span className={`${s.estado} ${s[`estado-${estado.split(" ")[0]}`] ?? ""}`} data-testid="tool-estado">
          {estado}
        </span>
        {cuota ? <span className={s.cuota}>{cuota} u</span> : null}
        <ChevronDown aria-hidden className={s.flecha} size="1em" />
      </summary>
      <div className={s.detalle}>
        <p className={s.tecnico}>
          Herramienta: <Mono>{bloque.name}</Mono>
        </p>
        <h4>Argumentos</h4>
        <pre>{JSON.stringify(bloque.input, null, 2)}</pre>
        {ruta && (
          <p data-testid="tool-ruta">
            <strong>Fichero:</strong> <Mono>{ruta}</Mono>
          </p>
        )}
        {bloque.result && (
          <>
            <h4>Datos</h4>
            <pre data-testid="tool-resultado" className={s.datos}>
              {bloque.result.content}
            </pre>
          </>
        )}
      </div>
    </details>
  );
}

/** "2 pasos · Leer tus últimos vídeos, Buscar en la base de conocimiento · 3 u de cuota" */
export function resumenPasos(bloques: BloqueTool[], cuotaPorTool: (nombre: string) => number): string {
  const etiquetas = [...new Set(bloques.map((b) => infoTool(b.name).etiqueta))];
  const lista = etiquetas.length > 2 ? `${etiquetas.slice(0, 2).join(", ")} y ${etiquetas.length - 2} más` : etiquetas.join(", ");
  const cuota = bloques.reduce((n, b) => n + cuotaPorTool(b.name), 0);
  return [`${bloques.length} ${bloques.length === 1 ? "paso" : "pasos"}`, lista, cuota ? `${cuota} u de cuota` : null].filter(Boolean).join(" · ");
}

export function GrupoPasos({ bloques }: { bloques: BloqueTool[] }) {
  const tools = useYoutubeTools().data;
  const enCurso = bloques.some((b) => !b.result);
  const algunError = bloques.some((b) => b.result?.is_error);
  return (
    <details className={s.grupo} open={enCurso} data-testid="pasos">
      <summary className={s.resumen}>
        {enCurso ? <Loader aria-hidden className={s.gira} size="1.15em" /> : algunError ? <CircleAlert aria-hidden className={s.fallo} size="1.15em" /> : <Check aria-hidden className={s.ok} size="1.15em" />}
        <span>{resumenPasos(bloques, (n) => tools?.[n]?.quota?.cost ?? 0)}</span>
        <ChevronDown aria-hidden className={s.flecha} size="1em" />
      </summary>
      <div className={s.pasos}>
        {bloques.map((b) => (
          <PasoTool key={b.id} bloque={b} />
        ))}
      </div>
    </details>
  );
}
