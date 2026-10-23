/** Tarjeta de aprobación inline (docs/pantallas.md → Chat → Tarjeta de aprobación).
 *  La salida del modelo es entrada no confiable: nada se ejecuta hasta que el usuario decide.
 *  Las destructivas exigen escribir el video_id exacto. */
import { useState } from "react";
import type { Approval } from "../api/types";

interface Props {
  approval: Approval;
  onResolver: (decision: "approve" | "reject", confirmId?: string) => Promise<unknown>;
}

export function ApprovalCard({ approval, onResolver }: Props) {
  const [confirm, setConfirm] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const destructiva = approval.risk === "destructive";
  const videoId = String(approval.args.video_id ?? "");
  const puedeAprobar = !enviando && (!approval.requires_confirm_id || (confirm !== "" && confirm === videoId));

  const decidir = async (decision: "approve" | "reject") => {
    setEnviando(true);
    setError(null);
    try {
      await onResolver(decision, decision === "approve" && approval.requires_confirm_id ? confirm : undefined);
    } catch (e) {
      setError((e as Error).message);
      setEnviando(false);
    }
  };

  return (
    <section className={`approval-card ${destructiva ? "destructiva" : ""}`} data-testid="approval-card" data-risk={approval.risk}>
      <header>
        <strong>El agente quiere ejecutar {approval.tool}</strong>
        <span className="chip" data-testid="approval-risk">{destructiva ? "DESTRUCTIVA" : "escritura"}</span>
      </header>
      {approval.quota && (
        <p data-testid="approval-quota">
          Coste de cuota: {approval.quota.cost} ({approval.quota.bucket})
        </p>
      )}
      <table data-testid="approval-args">
        <tbody>
          {Object.entries(approval.args).map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>
                {k === "video_id" ? <code className="mono" data-testid="approval-video-id">{formatear(v)}</code> : formatear(v)}
                {k === "file_path" && <em className="nota"> (la ruta real se resuelve al ejecutar)</em>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {approval.requires_confirm_id && (
        <input
          data-testid="approval-confirm"
          className="mono"
          placeholder="Escribe el video_id para confirmar"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={enviando}
          autoComplete="off"
          spellCheck={false}
        />
      )}
      {approval.requires_confirm_id && confirm !== "" && (
        <p className={confirm === videoId ? "nota" : "error"} data-testid="approval-confirm-estado" role="status">
          {confirm === videoId ? "El ID coincide" : "El ID no coincide"}
        </p>
      )}
      <div className="acciones">
        <button data-testid="approval-aprobar" onClick={() => decidir("approve")} disabled={!puedeAprobar}>
          Aprobar
        </button>
        <button data-testid="approval-rechazar" onClick={() => decidir("reject")} disabled={enviando}>
          Rechazar
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function formatear(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}
