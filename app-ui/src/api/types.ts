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

export type JobKind = "upload" | "transcribe" | "video_render";
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
  /** Solo si hay clave o no: la clave de ElevenLabs nunca vuelve a la UI. */
  has_elevenlabs_key?: boolean;
  has_client_secret: boolean;
  /** Proyecto de Google Cloud (client_secret.json) de toda la app; null si no hay ninguno. */
  google_project?: GoogleProject | null;
  state_dir: string;
  secret_store: string;
  /** Diagnóstico: debe ser null (si no, Whisper no puede bajar su modelo). */
  hf_hub_offline?: string | null;
}

/** El cliente OAuth llega enmascarado ("123456…wxyz"): identifica el proyecto sin exponerlo. */
export interface GoogleProject {
  project_id: string | null;
  client_id: string;
}

/** Respuesta de importar/quitar el client_secret.json: perfiles cuya autorización se ha perdido. */
export type SettingsTrasProyecto = Settings & { desautorizados: string[] };

/** Canal de YouTube que autorizó un perfil (lo lee el sidecar al autorizar). */
export interface CanalYouTube {
  id: string;
  title: string | null;
  handle: string | null;
}

export interface SettingsPatch {
  model?: Model;
  allowed_dirs?: AllowedDir[];
  profile?: string;
  /** Solo escritura: se envía una vez y nunca vuelve. Cadena vacía = borrar. */
  anthropic_api_key?: string;
  /** Solo escritura, como la de Anthropic. Cadena vacía = borrar. */
  elevenlabs_api_key?: string;
}

export interface YouTubeStatus {
  auth: {
    profile: string;
    profiles: string[];
    authenticated: boolean;
    store: string;
    /** Canal del perfil activo, si se conoce. */
    channel?: CanalYouTube | null;
    /** Canal de cada perfil autorizado (solo los que se conocen). */
    channels?: Record<string, CanalYouTube>;
    [k: string]: unknown;
  };
  quota: {
    buckets: Record<"general" | "search" | "video_insert", { used: number; limit: number }>;
    [k: string]: unknown;
  };
}

/** Conversación guardada en el sidecar (GET /conversations): `perfil`, el canal activo al crearla. */
export interface ConversacionResumen {
  id: string;
  titulo: string;
  perfil: string | null;
  creada: number;
  actualizada: number;
}

/** GET /conversations/{id}: cada turno, con el texto del usuario y los eventos SSE de la respuesta. */
export interface ConversacionDetalle extends ConversacionResumen {
  turnos: Array<{ texto: string; eventos: ChatEvent[] }>;
}

/** POST /youtube/auth: `duplicated_in`, otros perfiles que ya tenían autorizado este mismo canal. */
export interface YouTubeAuthOut {
  status: "authenticated";
  detail: YouTubeStatus["auth"];
  duplicated_in: string[];
}

/** Tarjeta de GET /kb/buscar?formato=json. `origen`: snapshot público o KB privada del usuario. */
export interface KbResultado {
  titulo: string;
  plataforma: string | null;
  plataformas: string[];
  fecha: string | null;
  url: string | null;
  origen: "publica" | "privada";
  fragmento: string;
}

/** Documento de GET /kb/fuentes?formato=json. */
export type KbFuente = Omit<KbResultado, "fragmento">;

/** Estado del snapshot instalado (GET /kb/estado → snapshot). */
export interface KbSnapshot {
  instalada: boolean;
  version: string | null;
  exportada: string | null;
  documentos: number | null;
  chunks: number | null;
  anterior_disponible: boolean;
  url: string;
  ultima_comprobacion?: string | null;
  ultimo_error?: string | null;
}

export interface KbEstado extends Texto {
  snapshot: KbSnapshot;
}

/** Documento de la KB privada (GET /kb/privada/fuentes). */
export interface KbPrivadaFuente {
  title: string | null;
  url: string;
  published_at: string | null;
  platforms: string[];
}

/** GET /youtube/channel: datos del Panel de canal (caché de 10 min en el sidecar). */
export interface CanalPanel {
  canal: { id: string; titulo: string; handle: string | null; avatar: string | null; suscriptores: number; visualizaciones_totales: number; videos: number };
  metricas: {
    inicio: string;
    fin: string;
    visualizaciones: number;
    visualizaciones_delta_pct: number | null;
    horas_vistas: number;
    suscriptores_netos: number;
    retencion_media: number;
  } | null;
  metricas_error: string | null;
  videos: Array<{
    id: string;
    titulo: string | null;
    publicado: string | null;
    visualizaciones: number;
    es_short: boolean;
    miniatura: string | null;
    estado: "private" | "public" | "unlisted" | null;
    programado_para: string | null;
  }>;
  actualizado: string;
  cache: boolean;
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

/** Navegador del render (Chrome for Testing): descarga a petición del usuario (`/video/navegador`). */
export type FaseNavegador = "ausente" | "descargando" | "verificando" | "extrayendo" | "listo" | "error";
export interface NavegadorEstado {
  version: string;
  tamano: number;
  estado: FaseNavegador;
  descargado: number;
  error: string | null;
}
export const FASES_ACTIVAS: readonly FaseNavegador[] = ["descargando", "verificando", "extrayendo"];

/** Solo lo que lee la UI de `GET /video/capacidades`. */
export interface CapacidadesVideo {
  chrome?: string;
  gpu?: { webgpu: boolean; detalle: string };
  codificadores?: { codificador: string; adaptador: string }[];
  [k: string]: unknown;
}

// --- Contrato REST de vídeo (tabla de la Task 9). Ningún tipo ni método lleva rutas (I6): solo ids de servidor. ---

export type EstadoProyectoVideo = "borrador" | "renderizando" | "listo" | "error";

export interface GuionVideoResumen {
  id: string;
  titulo: string;
  creado?: string;
  [k: string]: unknown;
}

export interface ProyectoVideoResumen {
  id: string;
  titulo: string;
  perfil: string;
  duracion: number;
  actualizado: string;
  estado: EstadoProyectoVideo;
}

export interface AvisoVideo {
  codigo: string;
  mensaje: string;
  ruta?: string; // ruta dentro del documento (p. ej. «escenas.0»), no del sistema de ficheros
}

/** Aviso de `POST …/preview`: el backend solo deja pasar el código (y los puertos ajenos), nunca texto (R2-2). */
export interface AvisoPreview {
  codigo: string;
  puertos?: number[];
}

export interface PreviewVideo {
  url: string;
  duracion: number;
  avisos: AvisoPreview[];
  fondo: string;
}

export type ModoRender = "auto" | "rapido" | "compatible";

/** `POST /video/proyectos/{id}/voz/coste` (contrato: `docs/video-fase1/contrato-voz.md`). La UI no calcula
 *  nada: cifra, refacturado y `plan` salen de aquí. */
export interface CosteVoz {
  pendientes: string[];
  caracteres: number;
  /** Caracteres de frases ya cobradas y no usables que se cobrarían otra vez. */
  caracteresRefacturados: number;
  fallidasFacturadas: string[];
  /** Opaco: huella del contenido que da el motor; se devuelve tal cual en `plan_confirmado`. */
  plan: string;
  voz: { id: string; nombre: string };
}
/** `GET /video/proyectos/{id}/voz/forma` (T5). */
export interface FormaVoz {
  picos: number[];
  segundos: number;
}
/** Cuerpo de `POST .../voz`: el motor compara plan y cifra con su propio cálculo; el backend no recalcula. */
export interface CuerpoVoz {
  plan_confirmado: string;
  caracteres_confirmados: number;
  frases?: string[];
  /** `true` solo si la persona marcó de forma explícita volver a pagar frases ya cobradas. */
  reintentar_facturadas: boolean;
}
/** Cuerpo de `POST .../voz/quitar-silencios`: no gasta, no lleva plan. */
export interface CuerpoQuitarSilencios {
  frase_id: string;
}
/** Cuerpo de `POST /video/voces/muestra` (además de `voiceId`). */
export interface CuerpoMuestra {
  plan_confirmado: string;
  caracteres_confirmados: number;
  reintentar_facturada: boolean;
}

export interface PerfilVideo {
  id: string;
  nombre?: string;
  [k: string]: unknown;
}
export interface VozVideo {
  id: string;
  nombre: string;
  /** Plan de la muestra (lo da el motor en `/video/voces`); se devuelve en `plan_confirmado`. */
  planMuestra?: string;
  [k: string]: unknown;
}
export interface PistaMusica {
  id: string;
  nombre?: string;
  [k: string]: unknown;
}
