/** Nombre legible e icono de cada tool del agente, en un único sitio. El nivel de riesgo no está
 *  aquí: sale de GET /youtube/tools (la fuente de verdad es el registro del sidecar). El nombre
 *  técnico solo se enseña en los detalles. */
import {
  Activity,
  AudioLines,
  BookOpen,
  BookmarkPlus,
  Captions,
  ChartLine,
  Film,
  FileChartColumn,
  FileText,
  Image,
  Lightbulb,
  ListMinus,
  ListPlus,
  ListVideo,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  Reply,
  Search,
  ShieldCheck,
  Tag,
  Trash2,
  TrendingUp,
  Tv,
  Upload,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export interface InfoTool {
  etiqueta: string;
  icono: LucideIcon;
}

const TOOLS: Record<string, InfoTool> = {
  youtube_upload_video: { etiqueta: "Subir vídeo a YouTube", icono: Upload },
  youtube_update_video: { etiqueta: "Actualizar un vídeo", icono: Pencil },
  youtube_delete_video: { etiqueta: "Borrar vídeo de YouTube", icono: Trash2 },
  youtube_list_videos: { etiqueta: "Leer tus últimos vídeos", icono: Film },
  youtube_get_video: { etiqueta: "Leer los datos de un vídeo", icono: Film },
  youtube_get_channel: { etiqueta: "Leer tu canal", icono: Tv },
  youtube_search: { etiqueta: "Buscar en YouTube", icono: Search },
  youtube_search_suggestions: { etiqueta: "Pedir sugerencias de búsqueda", icono: Lightbulb },
  youtube_trending: { etiqueta: "Ver las tendencias", icono: TrendingUp },
  youtube_get_categories: { etiqueta: "Leer las categorías", icono: Tag },
  youtube_list_comments: { etiqueta: "Leer comentarios", icono: MessageSquare },
  youtube_post_comment: { etiqueta: "Publicar un comentario", icono: MessageSquarePlus },
  youtube_reply_to_comment: { etiqueta: "Responder a un comentario", icono: Reply },
  youtube_list_playlists: { etiqueta: "Leer tus listas de reproducción", icono: ListVideo },
  youtube_create_playlist: { etiqueta: "Crear una lista de reproducción", icono: ListPlus },
  youtube_add_to_playlist: { etiqueta: "Añadir un vídeo a una lista", icono: ListPlus },
  youtube_remove_from_playlist: { etiqueta: "Quitar un vídeo de una lista", icono: ListMinus },
  youtube_set_thumbnail: { etiqueta: "Cambiar la miniatura", icono: Image },
  youtube_list_captions: { etiqueta: "Leer los subtítulos", icono: Captions },
  youtube_get_transcript: { etiqueta: "Leer la transcripción", icono: FileText },
  youtube_retention_moments: { etiqueta: "Ver dónde se va la audiencia", icono: Activity },
  youtube_auth: { etiqueta: "Autorizar YouTube", icono: ShieldCheck },
  youtube_auth_status: { etiqueta: "Comprobar la autorización de YouTube", icono: ShieldCheck },
  transcribe_local: { etiqueta: "Transcribir el vídeo en local", icono: AudioLines },
  buscar_kb: { etiqueta: "Buscar en la base de conocimiento", icono: BookOpen },
  estado_kb: { etiqueta: "Comprobar la base de conocimiento", icono: BookOpen },
  listar_fuentes: { etiqueta: "Listar las fuentes de la KB", icono: BookOpen },
  guardar_en_kb_privada: { etiqueta: "Guardar en tu base privada", icono: BookmarkPlus },
};

/** Familias con muchas variantes (analíticas, informes) que comparten nombre. */
const PREFIJOS: Array<[string, InfoTool]> = [
  ["youtube_analytics_", { etiqueta: "Consultar las analíticas del canal", icono: ChartLine }],
  ["youtube_reporting_", { etiqueta: "Gestionar informes de YouTube", icono: FileChartColumn }],
];

export function infoTool(nombre: string): InfoTool {
  const exacta = TOOLS[nombre];
  if (exacta) return exacta;
  const familia = PREFIJOS.find(([p]) => nombre.startsWith(p));
  if (familia) return familia[1];
  // Tool desconocida (nueva en el sidecar): nombre técnico sin guiones bajos, para no quedarse sin etiqueta.
  const texto = nombre.replace(/^youtube_/, "").replace(/_/g, " ");
  return { etiqueta: texto.charAt(0).toUpperCase() + texto.slice(1), icono: Wrench };
}

export const ETIQUETA_RIESGO = { read: "Lectura", write: "Escritura", destructive: "Destructiva" } as const;
