/** Secuencias de eventos con la forma observada en los E2E reales de la Fase 1
 *  (2026-10-11): publicación con rechazo, con aprobación + job, y borrado destructivo. */
import type { Approval, ChatEvent, Job } from "../api/types";

export const REJECTED_TEXT = "El usuario ha rechazado esta accion. No la repitas salvo que te lo pida.";

const uploadArgs = {
  file_path: "demo cs finance", // el modelo omite la extensión; la lista blanca resuelve a .mp4
  title: "Demo CS Finance",
  description: "Vídeo de prueba",
  privacy_status: "private",
};

export const approvalUpload: Approval = {
  id: "ap_upload",
  tool: "youtube_upload_video",
  args: uploadArgs,
  risk: "write",
  quota: { bucket: "video_insert", cost: 1 },
  status: "pending",
  requires_confirm_id: false,
};

export const jobUpload: Job = {
  id: "job_1",
  kind: "upload",
  args: uploadArgs,
  status: "queued",
  progress: 0,
  result: null,
  error: null,
  created_at: "2026-10-11T10:00:00Z",
  updated_at: "2026-10-11T10:00:00Z",
};

export const jobUploadDone: Job = {
  ...jobUpload,
  status: "done",
  progress: 1,
  result: {
    video_id: "abc123XYZ",
    file: "C:\\Users\\Marc\\Videos\\demo cs finance.mp4",
    url: "https://youtu.be/abc123XYZ",
  },
  updated_at: "2026-10-11T10:01:30Z",
};

export const usage = {
  input_tokens: 420,
  output_tokens: 180,
  cache_read_input_tokens: 13861,
  cache_creation_input_tokens: 0,
};

export const publicacionRechazada: ChatEvent[] = [
  { type: "text", delta: "Voy a subir el vídeo " },
  { type: "text", delta: "como privado." },
  { type: "tool_use", id: "tu_1", name: "youtube_upload_video", input: uploadArgs },
  { type: "approval_required", approval: approvalUpload },
  { type: "approval_resolved", approval: { ...approvalUpload, status: "rejected" } },
  { type: "tool_result", tool_use_id: "tu_1", is_error: false, content: REJECTED_TEXT },
  { type: "text", delta: "De acuerdo, no lo subo." },
  { type: "done", conversation_id: "conv_1", stop_reason: "end_turn", usage },
];

export const publicacionAprobada: ChatEvent[] = [
  { type: "tool_use", id: "tu_1", name: "youtube_upload_video", input: uploadArgs },
  { type: "approval_required", approval: approvalUpload },
  { type: "approval_resolved", approval: { ...approvalUpload, status: "approved" } },
  { type: "job_started", job: jobUpload },
  { type: "job_finished", job: jobUploadDone },
  {
    type: "tool_result",
    tool_use_id: "tu_1",
    is_error: false,
    content: JSON.stringify({ ...jobUploadDone.result, job_id: "job_1" }),
  },
  { type: "text", delta: "Subido como privado: https://youtu.be/abc123XYZ" },
  { type: "done", conversation_id: "conv_1", stop_reason: "end_turn", usage },
];

export const approvalDelete: Approval = {
  id: "ap_del",
  tool: "youtube_delete_video",
  args: { video_id: "abc123XYZ" },
  risk: "destructive",
  quota: { bucket: "general", cost: 50 },
  status: "pending",
  requires_confirm_id: true,
};

export const borradoDestructivo: ChatEvent[] = [
  { type: "tool_use", id: "tu_2", name: "youtube_delete_video", input: { video_id: "abc123XYZ" } },
  { type: "approval_required", approval: approvalDelete },
];

export const errorApi: ChatEvent[] = [
  { type: "text", delta: "Un momento" },
  { type: "error", message: "InternalServerError: overloaded" },
];

/** Serializa eventos tal y como los emite sse-starlette. */
export function aSse(events: ChatEvent[]): string {
  return events.map((e) => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join("");
}

export function streamDe(texto: string, trozo = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(texto);
  let i = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (i >= bytes.length) return ctrl.close();
      ctrl.enqueue(bytes.slice(i, i + trozo));
      i += trozo;
    },
  });
}
