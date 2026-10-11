/** Cliente HTTP tipado del sidecar. Solo habla con 127.0.0.1:<port> y manda el token en
 *  cada petición; el token vive en memoria y no se registra en ningún sitio. */
import { parseSse } from "./sse";
import type {
  Approval,
  ChatEvent,
  Job,
  JobKind,
  Settings,
  SettingsPatch,
  Texto,
  ToolInfo,
  YouTubeStatus,
} from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(detail);
  }
}

export interface Client {
  chat(
    body: { message: string; conversation_id?: string },
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent>;
  resolveApproval(id: string, decision: "approve" | "reject", confirmId?: string): Promise<Approval>;
  listJobs(): Promise<Job[]>;
  getJob(id: string): Promise<Job>;
  createJob(kind: JobKind, args: Record<string, unknown>): Promise<Job>;
  kbEstado(): Promise<Texto>;
  kbFuentes(plataforma?: string): Promise<Texto>;
  kbBuscar(q: string, plataforma?: string, k?: number): Promise<Texto>;
  youtubeStatus(): Promise<YouTubeStatus>;
  youtubeAuth(body: { profile?: string; reauthorize?: boolean }): Promise<unknown>;
  youtubeTools(): Promise<ToolInfo[]>;
  getSettings(): Promise<Settings>;
  putSettings(patch: SettingsPatch): Promise<Settings>;
  importClientSecret(body: { path?: string; json_text?: string }): Promise<Settings>;
}

export function createClient(port: number, token: string, fetchFn: typeof fetch = fetch): Client {
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetchFn(base + path, { ...init, headers: { ...headers, ...init.headers } });
    if (!res.ok) throw new ApiError(res.status, await detalle(res));
    return (await res.json()) as T;
  }
  const q = (params: Record<string, string | number | undefined>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") sp.set(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : "";
  };

  return {
    async *chat(body, signal) {
      const res = await fetchFn(`${base}/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new ApiError(res.status, await detalle(res));
      if (!res.body) throw new ApiError(0, "Respuesta sin cuerpo.");
      for await (const msg of parseSse(res.body)) {
        yield JSON.parse(msg.data) as ChatEvent;
      }
    },
    resolveApproval: (id, decision, confirmId) =>
      req(`/approvals/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify({ decision, confirm_id: confirmId }),
      }),
    listJobs: () => req("/jobs"),
    getJob: (id) => req(`/jobs/${encodeURIComponent(id)}`),
    createJob: (kind, args) =>
      req("/jobs", { method: "POST", body: JSON.stringify({ kind, args }) }),
    kbEstado: () => req("/kb/estado"),
    kbFuentes: (plataforma) => req(`/kb/fuentes${q({ plataforma })}`),
    kbBuscar: (qq, plataforma, k) => req(`/kb/buscar${q({ q: qq, plataforma, k })}`),
    youtubeStatus: () => req("/youtube/status"),
    youtubeAuth: (body) => req("/youtube/auth", { method: "POST", body: JSON.stringify(body) }),
    youtubeTools: () => req("/youtube/tools"),
    getSettings: () => req("/settings"),
    putSettings: (patch) => req("/settings", { method: "PUT", body: JSON.stringify(patch) }),
    importClientSecret: (body) =>
      req("/settings/client-secret", { method: "POST", body: JSON.stringify(body) }),
  };
}

async function detalle(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { detail?: unknown };
    if (typeof j.detail === "string") return j.detail;
    if (j.detail) return JSON.stringify(j.detail);
  } catch {
    /* sin cuerpo JSON */
  }
  return `HTTP ${res.status}`;
}
