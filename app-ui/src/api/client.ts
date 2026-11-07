/** Cliente HTTP tipado del sidecar. Solo habla con 127.0.0.1:<port> y manda el token en
 *  cada petición; el token vive en memoria y no se registra en ningún sitio. */
import type { Formato, RespuestaRetencion } from "../guiones/modelo";
import { parseSse } from "./sse";
import type {
  KbEstado,
  KbFuente,
  KbPrivadaFuente,
  KbResultado,
  CanalPanel,
  Approval,
  CapacidadesVideo,
  ChatEvent,
  ConversacionDetalle,
  ConversacionResumen,
  Job,
  JobKind,
  NavegadorEstado,
  Settings,
  SettingsPatch,
  SettingsTrasProyecto,
  Texto,
  ToolInfo,
  YouTubeAuthOut,
  YouTubeStatus,
  AvisoVideo,
  CosteVoz,
  CuerpoMuestra,
  CuerpoQuitarSilencios,
  CuerpoVoz,
  FormaVoz,
  GuionVideoResumen,
  ModoRender,
  PerfilVideo,
  PistaMusica,
  PreviewVideo,
  ProyectoVideoResumen,
  VozVideo,
} from "./types";
import type { Proyecto } from "../video/modelo";

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
    /** Código estable de `detail: { mensaje, codigo }`; la UI decide por él, nunca por el texto. */
    public codigo?: string,
  ) {
    super(detail);
  }
}

export interface Client {
  /** `sin_kb`: "Usar KB" apagado. `persistir: false`: conversación de trabajo (Publicar) que no se guarda. */
  chat(
    body: { message: string; conversation_id?: string; sin_kb?: boolean; persistir?: boolean },
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent>;
  listConversations(): Promise<ConversacionResumen[]>;
  getConversation(id: string): Promise<ConversacionDetalle>;
  deleteConversation(id: string): Promise<{ borrada: string }>;
  resolveApproval(id: string, decision: "approve" | "reject", confirmId?: string): Promise<Approval>;
  listJobs(): Promise<Job[]>;
  getJob(id: string): Promise<Job>;
  createJob(kind: JobKind, args: Record<string, unknown>): Promise<Job>;
  kbEstado(): Promise<KbEstado>;
  kbBuscarJson(q: string, plataforma?: string, k?: number): Promise<KbResultado[]>;
  kbFuentesJson(plataforma?: string): Promise<KbFuente[]>;
  kbUpdate(): Promise<{ accion: string; version?: string | null }>;
  kbPrivadaFuentes(): Promise<KbPrivadaFuente[]>;
  kbPrivadaAnadir(url: string): Promise<{ url: string; chunks: number; skipped: boolean }>;
  kbPrivadaBorrar(url: string): Promise<{ borrada: string }>;
  kbFuentes(plataforma?: string): Promise<Texto>;
  kbBuscar(q: string, plataforma?: string, k?: number): Promise<Texto>;
  youtubeStatus(): Promise<YouTubeStatus>;
  youtubeAuth(body: { profile?: string; reauthorize?: boolean }): Promise<YouTubeAuthOut>;
  /** Corta la autorización en curso: la youtubeAuth pendiente falla con "Autorización cancelada". */
  youtubeAuthCancel(): Promise<{ cancelada: boolean }>;
  youtubeTools(): Promise<ToolInfo[]>;
  guionesRetencion(videoId: string, format: Formato, language?: string): Promise<RespuestaRetencion>;
  youtubeChannel(refresh?: boolean): Promise<CanalPanel>;
  getSettings(): Promise<Settings>;
  putSettings(patch: SettingsPatch): Promise<Settings>;
  validateAnthropicKey(apiKey?: string): Promise<{ valida: boolean; detalle: string | null }>;
  /** 409 si es de otro proyecto y hay canales autorizados: repetir con `replace` tras confirmar. */
  importClientSecret(body: { path?: string; json_text?: string; replace?: boolean }): Promise<SettingsTrasProyecto>;
  removeClientSecret(): Promise<SettingsTrasProyecto>;
  videoNavegador(): Promise<NavegadorEstado>;
  /** Inicia la descarga (202). 409 si ya hay una en curso; 503 si el módulo de vídeo no está instalado. */
  videoNavegadorDescarga(): Promise<NavegadorEstado>;
  videoCapacidades(): Promise<CapacidadesVideo>;
  videoGuionEsquema(): Promise<Texto>;
  videoGuiones(): Promise<GuionVideoResumen[]>;
  /** 413 (cuerpo grande), 422 (esquema, con `problemas` en el detalle). */
  videoGuionCrear(guion: unknown): Promise<{ id: string; avisos: AvisoVideo[] }>;
  videoGuion(gid: string): Promise<unknown>;
  videoGuionBorrar(gid: string): Promise<Record<string, never>>;
  videoProyectos(): Promise<ProyectoVideoResumen[]>;
  videoProyectoCrear(guionId: string, perfilId: string): Promise<{ id: string }>;
  videoProyecto(id: string): Promise<Proyecto>;
  /** 409: la revisión enviada no es la actual. */
  videoProyectoGuardar(id: string, cuerpo: { revision: number; proyecto: Proyecto }): Promise<{ revision: number; avisos: AvisoVideo[] }>;
  videoProyectoBorrar(id: string): Promise<Record<string, never>>;
  videoPreviewAbrir(id: string, webgpu: boolean): Promise<PreviewVideo>;
  videoPreviewCerrar(id: string): Promise<Record<string, never>>;
  /** POST: el plan depende de `frases`. Nunca gasta; la cifra y el `plan` son los que luego se confirman. */
  videoVozCoste(id: string, frases?: string[]): Promise<CosteVoz>;
  videoVozForma(id: string): Promise<FormaVoz>;
  videoVozGenerar(id: string, cuerpo: CuerpoVoz): Promise<Record<string, unknown>>;
  /** No gasta y el motor guarda el proyecto: después hay que recargarlo del servidor. */
  videoVozQuitarSilencios(id: string, cuerpo: CuerpoQuitarSilencios): Promise<{ revision: number; recorte: { inicio: number; fin: number } }>;
  /** El recurso se identifica por `bandejaId` (32 hex que devuelve el comando nativo), nunca por ruta. */
  videoRecursoAnadir(id: string, bandejaId: string, clase: "foto" | "clip"): Promise<Record<string, unknown>>;
  videoRecursoBorrar(id: string, rid: string): Promise<Record<string, unknown>>;
  videoRender(id: string, modo: ModoRender): Promise<Job>;
  videoPerfiles(): Promise<PerfilVideo[]>;
  videoPerfilDuplicar(pid: string): Promise<PerfilVideo>;
  videoPerfilGuardar(pid: string, perfil: PerfilVideo): Promise<PerfilVideo>;
  videoVoces(): Promise<VozVideo[]>;
  videoVozMuestra(voiceId: string, cuerpo: CuerpoMuestra): Promise<Record<string, unknown>>;
  videoMusica(): Promise<PistaMusica[]>;
  videoMusicaImportar(bandejaId: string): Promise<PistaMusica>;
}

export function createClient(port: number, token: string, fetchFn: typeof fetch = fetch): Client {
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetchFn(base + path, { ...init, headers: { ...headers, ...init.headers } });
    if (!res.ok) {
      const { mensaje, codigo } = await detalleCodigo(res);
      throw new ApiError(res.status, mensaje, codigo);
    }
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
    listConversations: () => req("/conversations"),
    getConversation: (id) => req(`/conversations/${encodeURIComponent(id)}`),
    deleteConversation: (id) => req(`/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
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
    kbBuscarJson: (qq, plataforma, k) => req(`/kb/buscar${q({ q: qq, plataforma, k, formato: "json" })}`),
    kbFuentesJson: (plataforma) => req(`/kb/fuentes${q({ plataforma, formato: "json" })}`),
    kbUpdate: () => req("/kb/update", { method: "POST" }),
    kbPrivadaFuentes: () => req("/kb/privada/fuentes"),
    kbPrivadaAnadir: (url) => req("/kb/privada/fuentes", { method: "POST", body: JSON.stringify({ url }) }),
    kbPrivadaBorrar: (url) => req("/kb/privada/fuentes", { method: "DELETE", body: JSON.stringify({ url }) }),
    kbFuentes: (plataforma) => req(`/kb/fuentes${q({ plataforma })}`),
    kbBuscar: (qq, plataforma, k) => req(`/kb/buscar${q({ q: qq, plataforma, k })}`),
    youtubeStatus: () => req("/youtube/status"),
    youtubeAuth: (body) => req("/youtube/auth", { method: "POST", body: JSON.stringify(body) }),
    youtubeAuthCancel: () => req("/youtube/auth/cancel", { method: "POST" }),
    youtubeTools: () => req("/youtube/tools"),
    guionesRetencion: (videoId, format, language) => req(`/guiones/retencion${q({ video_id: videoId, format, language })}`),
    youtubeChannel: (refresh) => req(`/youtube/channel${refresh ? "?refresh=true" : ""}`),
    getSettings: () => req("/settings"),
    putSettings: (patch) => req("/settings", { method: "PUT", body: JSON.stringify(patch) }),
    validateAnthropicKey: (apiKey) => req("/settings/validate-key", { method: "POST", body: JSON.stringify({ api_key: apiKey }) }),
    importClientSecret: (body) =>
      req("/settings/client-secret", { method: "POST", body: JSON.stringify(body) }),
    removeClientSecret: () => req("/settings/client-secret", { method: "DELETE" }),
    videoNavegador: () => req("/video/navegador"),
    videoNavegadorDescarga: () => req("/video/navegador/descarga", { method: "POST" }),
    videoCapacidades: () => req("/video/capacidades"),
    videoGuionEsquema: () => req("/video/guiones/esquema"),
    videoGuiones: () => req("/video/guiones"),
    videoGuionCrear: (guion) => req("/video/guiones", { method: "POST", body: JSON.stringify({ guion }) }),
    videoGuion: (gid) => req(`/video/guiones/${encodeURIComponent(gid)}`),
    videoGuionBorrar: (gid) => req(`/video/guiones/${encodeURIComponent(gid)}`, { method: "DELETE" }),
    videoProyectos: () => req("/video/proyectos"),
    videoProyectoCrear: (guionId, perfilId) =>
      req("/video/proyectos", { method: "POST", body: JSON.stringify({ guion_id: guionId, perfil_id: perfilId }) }),
    videoProyecto: (id) => req(`/video/proyectos/${encodeURIComponent(id)}`),
    videoProyectoGuardar: (id, cuerpo) =>
      req(`/video/proyectos/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(cuerpo) }),
    videoProyectoBorrar: (id) => req(`/video/proyectos/${encodeURIComponent(id)}`, { method: "DELETE" }),
    videoPreviewAbrir: (id, webgpu) =>
      req(`/video/proyectos/${encodeURIComponent(id)}/preview`, { method: "POST", body: JSON.stringify({ webgpu }) }),
    videoPreviewCerrar: (id) => req(`/video/proyectos/${encodeURIComponent(id)}/preview`, { method: "DELETE" }),
    videoVozCoste: (id, frases) =>
      req(`/video/proyectos/${encodeURIComponent(id)}/voz/coste`, { method: "POST", body: JSON.stringify(frases ? { frases } : {}) }),
    videoVozForma: (id) => req(`/video/proyectos/${encodeURIComponent(id)}/voz/forma`),
    videoVozGenerar: (id, cuerpo) =>
      req(`/video/proyectos/${encodeURIComponent(id)}/voz`, { method: "POST", body: JSON.stringify(cuerpo) }),
    videoVozQuitarSilencios: (id, cuerpo) =>
      req(`/video/proyectos/${encodeURIComponent(id)}/voz/quitar-silencios`, { method: "POST", body: JSON.stringify(cuerpo) }),
    videoRecursoAnadir: (id, bandejaId, clase) =>
      req(`/video/proyectos/${encodeURIComponent(id)}/recursos`, { method: "POST", body: JSON.stringify({ bandeja_id: bandejaId, clase }) }),
    videoRecursoBorrar: (id, rid) =>
      req(`/video/proyectos/${encodeURIComponent(id)}/recursos/${encodeURIComponent(rid)}`, { method: "DELETE" }),
    videoRender: (id, modo) =>
      req(`/video/proyectos/${encodeURIComponent(id)}/render`, { method: "POST", body: JSON.stringify({ modo }) }),
    videoPerfiles: () => req("/video/perfiles"),
    videoPerfilDuplicar: (pid) => req(`/video/perfiles/${encodeURIComponent(pid)}/duplicar`, { method: "POST" }),
    videoPerfilGuardar: (pid, perfil) =>
      req(`/video/perfiles/${encodeURIComponent(pid)}`, { method: "PUT", body: JSON.stringify(perfil) }),
    videoVoces: () => req("/video/voces"),
    videoVozMuestra: (voiceId, cuerpo) => req("/video/voces/muestra", { method: "POST", body: JSON.stringify({ voiceId, ...cuerpo }) }),
    videoMusica: () => req("/video/musica"),
    videoMusicaImportar: (bandejaId) => req("/video/musica", { method: "POST", body: JSON.stringify({ bandeja_id: bandejaId }) }),
  };
}

/** `detail` puede ser un texto o `{ mensaje, codigo }` (contrato de la voz: `docs/video-fase1/contrato-voz.md`). */
async function detalleCodigo(res: Response): Promise<{ mensaje: string; codigo?: string }> {
  try {
    const j = (await res.json()) as { detail?: unknown };
    if (typeof j.detail === "string") return { mensaje: j.detail };
    if (j.detail && typeof j.detail === "object") {
      const d = j.detail as { mensaje?: unknown; codigo?: unknown };
      if (typeof d.mensaje === "string") return { mensaje: d.mensaje, codigo: typeof d.codigo === "string" ? d.codigo : undefined };
    }
    if (j.detail) return { mensaje: JSON.stringify(j.detail) };
  } catch {
    /* sin cuerpo JSON */
  }
  return { mensaje: `HTTP ${res.status}` };
}

async function detalle(res: Response): Promise<string> {
  return (await detalleCodigo(res)).mensaje;
}
