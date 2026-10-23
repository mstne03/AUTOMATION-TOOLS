/** Tarjeta de aprobación inline (docs/pantallas.md → Chat → Tarjeta de aprobación).
 *  La salida del modelo es entrada no confiable: nada se ejecuta hasta que el usuario decide.
 *  Las destructivas exigen escribir el video_id exacto. Al aparecer recibe el foco. */
import { Film } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Approval } from "../api/types";
import { Button, Chip, Input, Mono } from "../ui";
import s from "./ApprovalCard.module.css";
import { ETIQUETA_RIESGO, infoTool } from "./herramientas";

interface Props {
  approval: Approval;
  onResolver: (decision: "approve" | "reject", confirmId?: string) => Promise<unknown>;
}

const ETIQUETAS_ARG: Record<string, string> = {
  file_path: "Fichero",
  title: "Título",
  description: "Descripción",
  tags: "Etiquetas",
  privacy_status: "Visibilidad",
  publish_at: "Programada",
  video_id: "ID del vídeo",
};
const VISIBILIDAD: Record<string, string> = { private: "Privado", unlisted: "Oculto", public: "Público" };
const LARGO_DESCRIPCION = 140;

function Descripcion({ texto }: { texto: string }) {
  const [completa, setCompleta] = useState(false);
  if (texto.length <= LARGO_DESCRIPCION) return <>{texto}</>;
  return (
    <>
      <span className={s.suave}>{completa ? texto : texto.slice(0, LARGO_DESCRIPCION).trimEnd() + "…"}</span>{" "}
      <button type="button" className={s.enlace} onClick={() => setCompleta(!completa)} aria-expanded={completa}>
        {completa ? "Ocultar" : "Ver completa"}
      </button>
    </>
  );
}

function Valor({ clave, valor }: { clave: string; valor: unknown }): ReactNode {
  if (valor === null || valor === undefined || valor === "") return <span className={s.suave}>—</span>;
  if (clave === "tags" && Array.isArray(valor)) {
    return (
      <span className={s.etiquetas}>
        {valor.map((t) => (
          <span key={String(t)} className={s.etiqueta}>
            {String(t)}
          </span>
        ))}
      </span>
    );
  }
  if (clave === "privacy_status" && typeof valor === "string") return VISIBILIDAD[valor] ?? valor;
  if (clave === "description" && typeof valor === "string") return <Descripcion texto={valor} />;
  if (clave === "publish_at" && typeof valor === "string") {
    const f = new Date(valor);
    return Number.isNaN(f.getTime()) ? valor : f.toLocaleString("es-ES", { dateStyle: "long", timeStyle: "short" });
  }
  if (clave === "file_path") {
    return (
      <>
        <Mono>{String(valor)}</Mono>
        <em className={s.nota}> (la ruta real se resuelve al ejecutar)</em>
      </>
    );
  }
  if (clave === "video_id") return <Mono data-testid="approval-video-id">{String(valor)}</Mono>;
  return typeof valor === "string" ? valor : <Mono>{JSON.stringify(valor)}</Mono>;
}

/** Estado en vivo de lo tecleado frente al ID esperado (el campo sigue siendo obligatorio). */
function estadoConfirmacion(escrito: string, esperado: string): string {
  if (escrito === esperado) return "El ID coincide";
  if (esperado.startsWith(escrito)) {
    const faltan = esperado.length - escrito.length;
    return faltan === 1 ? "Falta 1 carácter" : `Faltan ${faltan} caracteres`;
  }
  return "El ID no coincide";
}

const APROBAR: Record<string, string> = { youtube_upload_video: "Aprobar y subir", youtube_delete_video: "Borrar definitivamente" };

export function ApprovalCard({ approval, onResolver }: Props) {
  const [confirm, setConfirm] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tecnico, setTecnico] = useState(false);
  const raiz = useRef<HTMLElement>(null);
  const titulo = useId();
  const destructiva = approval.risk === "destructive";
  const videoId = String(approval.args.video_id ?? "");
  const puedeAprobar = !enviando && (!approval.requires_confirm_id || (confirm !== "" && confirm === videoId));
  const info = infoTool(approval.tool);
  const Icono = info.icono;

  // Una aprobación pendiente bloquea al agente: se lleva el foco (y la vista) a la tarjeta.
  useEffect(() => {
    raiz.current?.focus();
  }, []);

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

  const cuota = approval.quota ? `${approval.quota.cost} ${approval.quota.cost === 1 ? "unidad" : "unidades"} de cuota (${approval.quota.bucket})` : null;
  const subtitulo = [destructiva ? "No se puede deshacer" : "Nada se ejecuta hasta que apruebes", cuota].filter(Boolean);

  return (
    <section
      ref={raiz}
      tabIndex={-1}
      role="group"
      aria-labelledby={titulo}
      className={`${s.tarjeta} ${destructiva ? s.destructiva : s.escritura}`}
      data-testid="approval-card"
      data-risk={approval.risk}
    >
      <header className={s.cabecera}>
        <div className={s.icono}>
          <Icono aria-hidden size="1.15em" />
        </div>
        <div className={s.titulos}>
          <strong id={titulo} className={s.titulo}>
            {info.etiqueta}
          </strong>
          <span className={s.subtitulo} data-testid={cuota ? "approval-quota" : undefined}>
            {subtitulo.join(" · ")}
          </span>
        </div>
        <Chip tone={destructiva ? "destructive" : "write"} data-testid="approval-risk">
          {destructiva ? ETIQUETA_RIESGO.destructive : ETIQUETA_RIESGO.write}
        </Chip>
      </header>

      {destructiva && videoId && (
        <div className={s.objetivo}>
          <div className={s.miniatura} aria-hidden>
            <Film size="1.25em" />
          </div>
          <div className={s.objetivoTexto}>
            <span className={s.objetivoNombre}>Vídeo de YouTube</span>
            <Mono className={s.objetivoId}>{videoId}</Mono>
          </div>
        </div>
      )}

      <table className={s.rejilla} data-testid="approval-args">
        <tbody>
          {Object.entries(approval.args).map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{ETIQUETAS_ARG[k] ?? k}</th>
              <td>
                <Valor clave={k} valor={v} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {approval.requires_confirm_id && (
        <div className={s.confirmar}>
          <label htmlFor={`${titulo}-id`} className={s.etiquetaConfirmar}>
            Escribe el ID para confirmar
          </label>
          <Input
            id={`${titulo}-id`}
            mono
            data-testid="approval-confirm"
            placeholder="Escribe el video_id para confirmar"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={enviando}
            autoComplete="off"
            spellCheck={false}
          />
          {confirm !== "" && (
            <span className={confirm === videoId ? s.coincide : s.noCoincide} data-testid="approval-confirm-estado" role="status">
              {estadoConfirmacion(confirm, videoId)}
            </span>
          )}
        </div>
      )}

      {tecnico && (
        <pre className={s.json} data-testid="approval-json">
          {approval.tool}
          {"\n"}
          {JSON.stringify(approval.args, null, 2)}
        </pre>
      )}

      <div className={s.acciones}>
        <button type="button" className={s.enlace} onClick={() => setTecnico(!tecnico)} aria-expanded={tecnico} data-testid="approval-tecnico">
          {tecnico ? "Ocultar detalles técnicos" : "Ver detalles técnicos"}
        </button>
        <Button variant="secondary" data-testid="approval-rechazar" onClick={() => decidir("reject")} disabled={enviando}>
          Rechazar
        </Button>
        <Button variant={destructiva ? "danger" : "primary"} data-testid="approval-aprobar" onClick={() => decidir("approve")} disabled={!puedeAprobar}>
          {APROBAR[approval.tool] ?? "Aprobar"}
        </Button>
      </div>
      {error && <p className={s.error}>{error}</p>}
    </section>
  );
}
