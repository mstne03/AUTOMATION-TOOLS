/** Contrato del sidecar `app-backend` (ver app-backend/README.md). Un solo módulo, a mano. */

export type Risk = "read" | "write" | "destructive";
export type Model = "claude-opus-5-5" | "claude-sonnet-5-5";

export interface Approval {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  risk: Risk;
  quota: { bucket: string; cost: number } | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requires_confirm_id: boolean;
}

export type JobKind = "upload" | "transcribe";
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  kind: JobKind;
  args: Record<string, unknown>;
  status: JobStatus;
  progress: number; // 0–1
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Eventos SSE de POST /chat, discriminados por `type`. */
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; is_error: boolean; content: string }
  | { type: "approval_required"; approval: Approval }
  | { type: "approval_resolved"; approval: Approval }
  | { type: "job_started"; job: Job }
  | { type: "job_finished"; job: Job }
  | { type: "done"; conversation_id: string; stop_reason: string | null; usage: Usage | null }
  | { type: "error"; message: string };

export interface AllowedDir {
  path: string;
  language: string | null;
}

export interface Settings {
  model: Model;
  models: Model[];
  allowed_dirs: AllowedDir[];
  profile: string;
  has_anthropic_key: boolean;
  has_client_secret: boolean;
  state_dir: string;
  secret_store: string;
  /** Diagnóstico: debe ser null (si no, Whisper no puede bajar su modelo). */
  hf_hub_offline?: string | null;
}

export interface SettingsPatch {
  model?: Model;
  allowed_dirs?: AllowedDir[];
  profile?: string;
  /** Solo escritura: se envía una vez y nunca vuelve. Cadena vacía = borrar. */
  anthropic_api_key?: string;
}

export interface YouTubeStatus {
  auth: {
    profile: string;
    profiles: string[];
    authenticated: boolean;
    store: string;
    [k: string]: unknown;
  };
  quota: {
    buckets: Record<"general" | "search" | "video_insert", { used: number; limit: number }>;
    [k: string]: unknown;
  };
}

export interface ToolInfo {
  name: string;
  risk: Risk;
  quota: { bucket: string; cost: number } | null;
  job_kind: JobKind | null;
}

export interface Texto {
  texto: string;
}
