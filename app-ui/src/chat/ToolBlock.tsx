/** Bloque de llamada a tool dentro de un turno (docs/pantallas.md → Chat → Tool). */
import type { Approval, Job } from "../api/types";
import { useJobs } from "../state/jobs";
import { ApprovalCard } from "./ApprovalCard";
import { rutaResuelta, type BloqueTool } from "./turno";

interface Props {
  bloque: BloqueTool;
  onResolver: (approval: Approval, decision: "approve" | "reject", confirmId?: string) => Promise<unknown>;
}

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

export function ToolBlock({ bloque: original, onResolver }: Props) {
  const vivo = useJobs((s) => (original.job ? s.jobs[original.job.id] : undefined));
  const job = masNuevo(original.job, vivo);
  const bloque = job === original.job ? original : { ...original, job };
  const estado = estadoTool(bloque);
  const ruta = rutaResuelta(bloque);
  const pendiente = bloque.approval?.status === "pending";
  const riesgo = bloque.approval?.risk ?? "read";
  return (
    <details className="bloque-tool" data-testid="bloque-tool" data-tool={bloque.name} open={pendiente}>
      <summary>
        <code>{bloque.name}</code> · {riesgo} ·{" "}
        <span className={`tool-estado estado-${estado.split(" ")[0]}`} data-testid="tool-estado">
          {estado}
        </span>
      </summary>
      {pendiente && bloque.approval && (
        <ApprovalCard approval={bloque.approval} onResolver={(d, c) => onResolver(bloque.approval!, d, c)} />
      )}
      <div className="tool-detalle">
        <h4>Argumentos</h4>
        <pre>{JSON.stringify(bloque.input, null, 2)}</pre>
        {ruta && (
          <p data-testid="tool-ruta">
            <strong>Fichero:</strong> <code>{ruta}</code>
          </p>
        )}
        {bloque.result && (
          <>
            <h4>Datos</h4>
            <pre data-testid="tool-resultado" className="datos">
              {bloque.result.content}
            </pre>
          </>
        )}
      </div>
    </details>
  );
}
