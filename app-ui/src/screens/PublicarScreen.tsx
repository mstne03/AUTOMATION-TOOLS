/** Publicar vídeo (docs/pantallas.md → Publicar): ruta dentro de allowed_dirs, transcripción
 *  como job, borrador generado por el agente y editable, subida con aprobación inline. */
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useClient } from "../api/context";
import { useSettings } from "../api/queries";
import type { Job } from "../api/types";
import { TurnoView } from "../chat/ChatScreen";
import { useChat } from "../chat/useChat";

interface Borrador {
  title: string;
  description: string;
  tags: string;
  privacy: "private" | "unlisted" | "public";
  publishAt: string;
}

const vacio: Borrador = { title: "", description: "", tags: "", privacy: "private", publishAt: "" };

const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

/** Extrae el primer objeto JSON de un texto del modelo. */
export function extraerJson(texto: string): Partial<Borrador> | null {
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    return {
      title: typeof j.title === "string" ? j.title : undefined,
      description: typeof j.description === "string" ? j.description : undefined,
      tags: Array.isArray(j.tags) ? j.tags.join(", ") : typeof j.tags === "string" ? j.tags : undefined,
    };
  } catch {
    return null;
  }
}

export function PublicarScreen() {
  const client = useClient();
  const settings = useSettings();
  const chat = useChat();
  const [path, setPath] = useState("");
  const [transcripcion, setTranscripcion] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [borrador, setBorrador] = useState<Borrador>(vacio);
  const [esperandoBorrador, setEsperandoBorrador] = useState(false);

  const dirs = settings.data?.allowed_dirs ?? [];
  const pathOk = path.trim() !== "" && dirs.some((d) => norm(path).startsWith(norm(d.path) + "\\"));
  const pathError = path.trim() !== "" && !pathOk;

  const transcribir = useMutation({
    mutationFn: async () => {
      let j = await client.createJob("transcribe", { file: path.trim() });
      setJob(j);
      while (j.status === "queued" || j.status === "running") {
        await new Promise((r) => setTimeout(r, 1000));
        j = await client.getJob(j.id);
        setJob(j);
      }
      if (j.status === "failed") throw new Error(j.error ?? "La transcripción ha fallado.");
      const texto = (j.result as { text?: string } | null)?.text;
      setTranscripcion(typeof texto === "string" ? texto : JSON.stringify(j.result));
    },
  });

  // Cuando el agente termina el turno del borrador, rellena los campos con su JSON.
  useEffect(() => {
    if (!esperandoBorrador || chat.enStream) return;
    const ultimo = chat.mensajes[chat.mensajes.length - 1];
    if (ultimo?.role !== "assistant" || ultimo.turno.estado === "streaming") return;
    const texto = ultimo.turno.bloques.filter((b) => b.kind === "text").map((b) => b.text).join("\n");
    const j = extraerJson(texto);
    if (j) setBorrador((b) => ({ ...b, ...Object.fromEntries(Object.entries(j).filter(([, v]) => v !== undefined)) }));
    setEsperandoBorrador(false);
  }, [chat.mensajes, chat.enStream, esperandoBorrador]);

  const generarBorrador = () => {
    setEsperandoBorrador(true);
    void chat.enviar(
      `Prepara un borrador SEO para publicar el vídeo ${path.trim()}. ` +
        (transcripcion ? `Transcripción:\n"""\n${transcripcion.slice(0, 6000)}\n"""\n` : "") +
        'Consulta la base de conocimiento si ayuda. Responde SOLO con un JSON {"title": string, "description": string, "tags": string[]}. No subas nada.',
    );
  };

  const subir = () => {
    const tags = borrador.tags.split(",").map((t) => t.trim()).filter(Boolean);
    void chat.enviar(
      `Sube el vídeo ${path.trim()} a YouTube con exactamente estos datos y pide mi aprobación: ` +
        JSON.stringify({
          title: borrador.title,
          description: borrador.description,
          tags,
          privacy_status: borrador.privacy,
          publish_at: borrador.publishAt ? new Date(borrador.publishAt).toISOString() : null,
        }),
    );
  };

  const set = (k: keyof Borrador) => (e: { target: { value: string } }) => setBorrador({ ...borrador, [k]: e.target.value });

  return (
    <div className="publicar">
      <h1>Publicar vídeo</h1>

      <section data-testid="publicar-fichero">
        <h2>1. Fichero</h2>
        {dirs.length === 0 && <p className="error">No hay carpetas permitidas. Añade una en Ajustes.</p>}
        <input data-testid="publicar-path" placeholder={dirs[0] ? `${dirs[0].path}\\mi-video.mp4` : "ruta del vídeo"} value={path} onChange={(e) => setPath(e.target.value)} />
        {pathError && (
          <p className="error" data-testid="publicar-path-error">
            La ruta debe estar dentro de una carpeta permitida: {dirs.map((d) => d.path).join(", ")}
          </p>
        )}
      </section>

      <section>
        <h2>2. Transcripción (opcional, local)</h2>
        <button data-testid="publicar-transcribir" disabled={!pathOk || transcribir.isPending} onClick={() => transcribir.mutate()}>
          {transcribir.isPending ? "Transcribiendo…" : "Transcribir"}
        </button>
        {job && (job.status === "queued" || job.status === "running") && (
          <label data-testid="publicar-progreso">
            <progress value={job.progress} max={1} /> {Math.round(job.progress * 100)} %
          </label>
        )}
        {transcribir.error && <p className="error">{transcribir.error.message}</p>}
        {transcripcion !== null && (
          <textarea data-testid="publicar-transcripcion" rows={5} value={transcripcion} onChange={(e) => setTranscripcion(e.target.value)} />
        )}
      </section>

      <section data-testid="publicar-borrador">
        <h2>3. Borrador</h2>
        <button data-testid="borrador-generar" disabled={!pathOk || chat.enStream} onClick={generarBorrador}>
          {esperandoBorrador && chat.enStream ? "Generando…" : "Generar borrador con el agente"}
        </button>
        <label>
          Título
          <input data-testid="borrador-title" value={borrador.title} onChange={set("title")} maxLength={100} />
        </label>
        <label>
          Descripción
          <textarea data-testid="borrador-description" rows={5} value={borrador.description} onChange={set("description")} />
        </label>
        <label>
          Etiquetas (separadas por comas)
          <input data-testid="borrador-tags" value={borrador.tags} onChange={set("tags")} />
        </label>
        <div className="fila">
          <label>
            Visibilidad
            <select data-testid="borrador-privacy" value={borrador.privacy} onChange={set("privacy")}>
              <option value="private">privado</option>
              <option value="unlisted">oculto</option>
              <option value="public">público</option>
            </select>
          </label>
          <label>
            Programar (opcional)
            <input type="datetime-local" data-testid="borrador-publishAt" value={borrador.publishAt} onChange={set("publishAt")} />
          </label>
        </div>
      </section>

      <section>
        <h2>4. Subir</h2>
        <button data-testid="publicar-subir" disabled={!pathOk || !borrador.title.trim() || chat.enStream} onClick={subir}>
          Pedir al agente que lo suba
        </button>
        <p className="nota">La subida no empieza hasta que apruebes la propuesta que aparecerá abajo.</p>
      </section>

      <section className="publicar-chat" data-testid="publicar-turnos">
        {chat.mensajes
          .filter((m) => m.role === "assistant")
          .map((m, i) =>
            m.role === "assistant" ? (
              <article className="msg msg-assistant" data-testid="msg-assistant" key={i}>
                <TurnoView turno={m.turno} onResolver={chat.resolver} />
              </article>
            ) : null,
          )}
      </section>
    </div>
  );
}
