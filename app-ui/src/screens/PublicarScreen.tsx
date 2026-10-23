/** Publicar vídeo (docs/pantallas.md → Publicar): asistente en cuatro pasos (vídeo, transcripción,
 *  borrador, revisar y subir) con vista previa y comprobaciones en vivo, barra inferior fija y la
 *  aprobación en un diálogo. El estado vive en state/publicar.ts, así que sobrevive a cambiar de pantalla. */
import { Check, Film, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useClient } from "../api/context";
import { useSettings, useYoutubeStatus } from "../api/queries";
import { ApprovalCard } from "../chat/ApprovalCard";
import { TurnoView } from "../chat/ChatScreen";
import { useChat } from "../chat/useChat";
import { elegirVideo } from "../dialogo";
import { comprobar, compararConBorrador, motivoBloqueo, zonaHoraria, MAX_DESCRIPCION_BYTES, MAX_ETIQUETAS, MAX_TITULO, bytesUtf8, longitudEtiquetas, type Nivel } from "../publicar/limites";
import { jobActivo, useJobs } from "../state/jobs";
import { descartar, parcharBorrador, setEsperandoBorrador, setPath, setTranscripcion, transcribir, usePublicar, type Borrador } from "../state/publicar";
import { Button, ConfirmDialog, Dialog, Field, Input, Mono, Progress, SegmentedControl, TagInput, Textarea } from "../ui";
import { cx } from "../ui/cx";
import s from "./PublicarScreen.module.css";

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

const SIMBOLO: Record<Nivel, string> = { ok: "✓", aviso: "!", error: "✕", info: "·" };

export function PublicarScreen() {
  const client = useClient();
  const settings = useSettings();
  const youtube = useYoutubeStatus();
  const chat = useChat("publicar");
  const { path, transcripcion, jobId, transcribiendo, errorTranscripcion, borrador, esperandoBorrador } = usePublicar();
  const job = useJobs((st) => (jobId ? st.jobs[jobId] : undefined));
  const [errorDialogo, setErrorDialogo] = useState<string | null>(null);
  const [descartando, setDescartando] = useState(false);
  const [aceptaDiferencias, setAceptaDiferencias] = useState(false);
  const campoRuta = useRef<HTMLInputElement>(null);
  const seccionTranscripcion = useRef<HTMLDetailsElement>(null);
  const campoTitulo = useRef<HTMLInputElement>(null);

  const dirs = settings.data?.allowed_dirs ?? [];
  const pathOk = path.trim() !== "" && dirs.some((d) => norm(path).startsWith(norm(d.path) + "\\"));
  const pathError = path.trim() !== "" && !pathOk;
  const tags = useMemo(() => borrador.tags.split(",").map((t) => t.trim()).filter(Boolean), [borrador.tags]);
  const cuota = youtube.data?.quota.buckets.video_insert;

  const comprobaciones = comprobar({
    title: borrador.title,
    description: borrador.description,
    tags,
    publishAt: borrador.publishAt,
    rutaVacia: path.trim() === "",
    rutaPermitida: pathOk,
    cuota,
    ahora: Date.now(),
  });
  const bloqueo = motivoBloqueo(comprobaciones);
  const motivoSubir = bloqueo ?? (chat.enStream ? "Espera a que el agente termine la respuesta en curso." : null);

  // Aprobación pendiente de la subida: se revisa en un diálogo, no debajo del formulario (UI-08).
  const pendiente = useMemo(() => {
    const ultimo = [...chat.mensajes].reverse().find((m) => m.role === "assistant");
    if (ultimo?.role !== "assistant") return null;
    for (const b of ultimo.turno.bloques) if (b.kind === "tool" && b.approval?.status === "pending") return b.approval;
    return null;
  }, [chat.mensajes]);
  const diferencias = useMemo(
    () => (pendiente?.tool === "youtube_upload_video" ? compararConBorrador(pendiente.args, { title: borrador.title, description: borrador.description, tags, privacy: borrador.privacy, publishAt: borrador.publishAt }) : []),
    [pendiente, borrador, tags],
  );
  useEffect(() => setAceptaDiferencias(false), [pendiente?.id]);

  const elegir = async () => {
    setErrorDialogo(null);
    try {
      const elegido = await elegirVideo(dirs[0]?.path ?? "");
      if (elegido) setPath(elegido);
    } catch (e) {
      setErrorDialogo(String((e as Error)?.message ?? e));
    }
  };

  // Cuando el agente termina el turno del borrador, rellena los campos con su JSON.
  useEffect(() => {
    if (!esperandoBorrador || chat.enStream) return;
    const ultimo = chat.mensajes[chat.mensajes.length - 1];
    if (ultimo?.role !== "assistant" || ultimo.turno.estado === "streaming") return;
    const texto = ultimo.turno.bloques.filter((b) => b.kind === "text").map((b) => b.text).join("\n");
    const j = extraerJson(texto);
    if (j) parcharBorrador(Object.fromEntries(Object.entries(j).filter(([, v]) => v !== undefined)));
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

  const cambiarFecha = (valor: string) => parcharBorrador(valor ? { publishAt: valor, privacy: "private" } : { publishAt: "" });

  const nombre = path.split(/[\\/]/).pop() ?? "";
  const carpeta = path.slice(0, path.length - nombre.length).replace(/[\\/]+$/, "");
  const tieneBorrador = borrador.title.trim() !== "" || borrador.description.trim() !== "" || tags.length > 0;
  const hayTurnos = chat.mensajes.some((m) => m.role === "assistant");

  // Estado del asistente derivado de los datos: el primer paso no completado es el actual.
  // La transcripción es opcional: se da por pasada en cuanto hay título, aunque no se haya hecho.
  const hecho = [pathOk, transcripcion !== null, borrador.title.trim() !== ""];
  const actual = [hecho[0], hecho[1] || hecho[2], hecho[2]].findIndex((h) => !h);
  const pasoActual = actual === -1 ? 3 : actual;
  const pasos: Array<{ nombre: string; ir: () => void }> = [
    { nombre: "Vídeo", ir: () => campoRuta.current?.focus() },
    {
      nombre: "Transcripción",
      ir: () => {
        if (seccionTranscripcion.current) seccionTranscripcion.current.open = true;
        seccionTranscripcion.current?.scrollIntoView({ block: "nearest" });
      },
    },
    { nombre: "Borrador", ir: () => campoTitulo.current?.focus() },
    { nombre: "Revisar y subir", ir: () => undefined },
  ];

  return (
    <div className={s.pantalla}>
      <header className={s.cabecera}>
        <h1 className={s.titulo}>Publicar vídeo</h1>
        <ol className={s.pasos} aria-label="Pasos" data-testid="publicar-pasos">
          {pasos.map((p, i) => {
            const completo = i < 3 && hecho[i];
            const esActual = i === pasoActual;
            return (
              <li key={p.nombre} className={s.pasoItem} aria-current={esActual ? "step" : undefined} data-estado={completo ? "hecho" : esActual ? "actual" : "pendiente"} data-testid={`publicar-paso-${i + 1}`}>
                {i > 0 && <span className={s.union} aria-hidden />}
                <button type="button" className={cx(s.paso, completo && s.pasoHecho, esActual && s.pasoActual)} onClick={p.ir} disabled={!completo}>
                  <span className={s.pasoNumero}>{completo ? <Check aria-hidden size="0.9em" /> : i + 1}</span>
                  {p.nombre}
                </button>
              </li>
            );
          })}
        </ol>
      </header>

      <div className={s.cuerpo}>
        <div className={s.principal}>
          <section className={s.tarjetaVideo} data-testid="publicar-fichero" aria-label="Vídeo">
            <div className={s.videoFila}>
              <div className={s.miniatura} aria-hidden>
                <Film size="1.4em" />
              </div>
              <div className={s.videoDatos}>
                <span className={s.videoNombre}>{pathOk ? nombre : "Ningún vídeo elegido"}</span>
                <span className={s.videoCarpeta}>{pathOk ? carpeta : dirs[0] ? `Carpeta permitida: ${dirs[0].path}` : "Sin carpetas permitidas"}</span>
              </div>
              <Button size="sm" data-testid="publicar-elegir" disabled={dirs.length === 0} onClick={() => void elegir()}>
                {pathOk ? "Cambiar…" : "Elegir vídeo…"}
              </Button>
            </div>
            {dirs.length === 0 && <p className={s.error}>No hay carpetas permitidas. Añade una en Ajustes.</p>}
            <Field label="Ruta del vídeo" errorTestId="publicar-path-error" error={pathError ? `La ruta debe estar dentro de una carpeta permitida: ${dirs.map((d) => d.path).join(", ")}` : undefined}>
              <Input ref={campoRuta} mono data-testid="publicar-path" placeholder={dirs[0] ? `${dirs[0].path}\\mi-video.mp4` : "ruta del vídeo"} value={path} onChange={(e) => setPath(e.target.value)} />
            </Field>
            {errorDialogo && (
              <p className={s.error} data-testid="publicar-elegir-error">
                {errorDialogo}
              </p>
            )}
          </section>

          <details ref={seccionTranscripcion} className={s.transcripcion} open={transcripcion === null || transcribiendo}>
            <summary>
              Transcripción{" "}
              <span className={s.suave}>
                {transcribiendo ? "· transcribiendo…" : transcripcion === null ? "· opcional, local" : transcripcion.trim() ? "· lista" : "· sin voz detectada; el borrador se genera sin ella"}
              </span>
            </summary>
            <div className={s.transcripcionCuerpo}>
              <div>
                <Button size="sm" data-testid="publicar-transcribir" disabled={!pathOk || transcribiendo} loading={transcribiendo} onClick={() => void transcribir(client)}>
                  {transcribiendo ? "Transcribiendo…" : transcripcion === null ? "Transcribir" : "Transcribir de nuevo"}
                </Button>
              </div>
              {job && jobActivo(job) && (
                <div data-testid="publicar-progreso">
                  <Progress label="Transcribiendo" value={job.progress} />
                </div>
              )}
              {errorTranscripcion && <p className={s.error}>{errorTranscripcion}</p>}
              {transcripcion !== null && !transcripcion.trim() && <p data-testid="publicar-sin-voz">No se ha detectado voz en el vídeo: el borrador se generará sin transcripción.</p>}
              {transcripcion !== null && transcripcion.trim() !== "" && (
                <Textarea data-testid="publicar-transcripcion" rows={5} aria-label="Texto de la transcripción" value={transcripcion} onChange={(e) => setTranscripcion(e.target.value)} />
              )}
            </div>
          </details>

          <section className={s.borrador} data-testid="publicar-borrador" aria-labelledby="publicar-borrador-titulo">
            <div className={s.borradorCabecera}>
              <h2 id="publicar-borrador-titulo" className={s.h2}>
                Borrador
              </h2>
              <button type="button" className={s.regenerar} data-testid="borrador-generar" disabled={!pathOk || chat.enStream} onClick={generarBorrador}>
                <Sparkles aria-hidden size="1em" />
                {esperandoBorrador && chat.enStream ? "Generando…" : tieneBorrador ? "Regenerar con el agente" : "Generar con el agente"}
              </button>
            </div>
            <Field label="Título" count={borrador.title.length} max={MAX_TITULO}>
              <Input ref={campoTitulo} data-testid="borrador-title" value={borrador.title} onChange={(e) => parcharBorrador({ title: e.target.value })} />
            </Field>
            <Field label="Descripción" count={bytesUtf8(borrador.description)} max={MAX_DESCRIPCION_BYTES} help="YouTube cuenta bytes (UTF-8): las tildes y los emojis pesan más de uno.">
              <Textarea data-testid="borrador-description" rows={4} value={borrador.description} onChange={(e) => parcharBorrador({ description: e.target.value })} />
            </Field>
            <Field label="Etiquetas" count={longitudEtiquetas(tags)} max={MAX_ETIQUETAS}>
              <TagInput value={tags} onChange={(t) => parcharBorrador({ tags: t.join(", ") })} placeholder="Añadir…" inputTestId="borrador-tags" />
            </Field>
            <div className={s.opciones}>
              <div className={s.visibilidad}>
                <span className={s.etiquetaCampo}>Visibilidad</span>
                <SegmentedControl
                  aria-label="Visibilidad"
                  data-testid="borrador-privacy"
                  value={borrador.privacy}
                  onChange={(v) => parcharBorrador({ privacy: v })}
                  options={[
                    { value: "private", label: "Privado" },
                    { value: "unlisted", label: "Oculto", disabled: borrador.publishAt !== "" },
                    { value: "public", label: "Público", disabled: borrador.publishAt !== "" },
                  ]}
                />
              </div>
              <Field label="Programar" className={s.programar} help={borrador.publishAt ? `Hora de ${zonaHoraria()}. Se sube privado y YouTube lo publica a esa hora.` : `Opcional. Hora de ${zonaHoraria()}.`}>
                <Input type="datetime-local" data-testid="borrador-publishAt" value={borrador.publishAt} onChange={(e) => cambiarFecha(e.target.value)} />
              </Field>
            </div>
          </section>

          {hayTurnos && (
            <section className={s.turnos} data-testid="publicar-turnos" aria-label="Respuesta del agente">
              {chat.mensajes
                .filter((m) => m.role === "assistant")
                .map((m, i) =>
                  m.role === "assistant" ? (
                    <article className={s.turno} data-testid="msg-assistant" key={i}>
                      <TurnoView turno={m.turno} onResolver={chat.resolver} sinAprobaciones />
                    </article>
                  ) : null,
                )}
            </section>
          )}
        </div>

        <aside className={s.lateral} aria-label="Vista previa">
          <div className={s.panel}>
            <span className={s.panelTitulo}>Así se verá en YouTube</span>
            <div className={s.previa} aria-hidden>
              <Film size="2em" />
            </div>
            <span className={s.previaTitulo} data-testid="publicar-previa-titulo">
              {borrador.title.trim() || "Sin título"}
            </span>
            <span className={s.previaMeta}>
              {youtube.data?.auth.profile ? `@${youtube.data.auth.profile} · ` : ""}
              {borrador.publishAt ? `programado para el ${new Date(borrador.publishAt).toLocaleDateString("es-ES", { day: "numeric", month: "short" })}` : { private: "privado", unlisted: "oculto", public: "público" }[borrador.privacy]}
            </span>
          </div>
          <div className={s.panel}>
            <span className={s.panelTitulo}>Comprobaciones</span>
            <ul className={s.comprobaciones} data-testid="publicar-comprobaciones">
              {comprobaciones.map((c) => (
                <li key={c.id} className={s[`nivel-${c.nivel}`]} data-nivel={c.nivel}>
                  <span aria-hidden className={s.simbolo}>
                    {SIMBOLO[c.nivel]}
                  </span>
                  <span>{c.texto}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      <footer className={s.pie}>
        {motivoSubir ? (
          <span className={cx(s.estadoPie, s.motivo)} data-testid="publicar-subir-motivo">
            {motivoSubir}
          </span>
        ) : (
          <span className={s.estadoPie}>Borrador guardado automáticamente · nada se sube sin tu aprobación</span>
        )}
        <Button onClick={() => setDescartando(true)} disabled={!tieneBorrador && !pathOk && transcripcion === null && !hayTurnos}>
          Descartar
        </Button>
        <Button variant="primary" data-testid="publicar-subir" disabled={motivoSubir !== null} onClick={subir}>
          Revisar y subir
        </Button>
      </footer>

      <ConfirmDialog open={descartando} onOpenChange={setDescartando} title="¿Descartar el borrador?" description="Se borran el vídeo elegido, la transcripción, el borrador y la conversación con el agente de esta pantalla." confirmLabel="Descartar" tone="danger" onConfirm={descartar} />

      <Dialog open={pendiente !== null} onOpenChange={() => undefined} dismissible={false} wide title="Revisar y subir" description="El agente ha preparado esta subida. No se sube nada hasta que la apruebes.">
        {pendiente && (
          <div data-testid="publicar-aprobacion">
            <ApprovalCard
              key={pendiente.id}
              approval={pendiente}
              onResolver={(d, c) => chat.resolver(pendiente, d, c)}
              aprobarDeshabilitado={diferencias.length > 0 && !aceptaDiferencias}
              extra={
                pendiente.tool === "youtube_upload_video" ? (
                  diferencias.length === 0 ? (
                    <p className={s.coincide} data-testid="publicar-coincide">
                      <Check aria-hidden size="1em" /> Coincide con tu borrador
                    </p>
                  ) : (
                    <div className={s.diferencias} data-testid="publicar-diferencias" role="alert">
                      <p className={s.diferenciasTitulo}>
                        <TriangleAlert aria-hidden size="1em" /> El agente propone algo distinto de tu borrador
                      </p>
                      <ul>
                        {diferencias.map((d) => (
                          <li key={d.campo}>
                            <strong>{d.campo}</strong>
                            <span>
                              Borrador: <Mono>{d.borrador || "(vacío)"}</Mono>
                            </span>
                            <span>
                              Propuesto: <Mono>{d.propuesto || "(vacío)"}</Mono>
                            </span>
                          </li>
                        ))}
                      </ul>
                      <label className={s.acepto}>
                        <input type="checkbox" data-testid="publicar-acepto" checked={aceptaDiferencias} onChange={(e) => setAceptaDiferencias(e.target.checked)} /> Acepto estas diferencias
                      </label>
                    </div>
                  )
                ) : null
              }
            />
          </div>
        )}
      </Dialog>
    </div>
  );
}
