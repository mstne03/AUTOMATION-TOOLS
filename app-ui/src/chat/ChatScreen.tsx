/** Pantalla de chat (docs/pantallas.md → Chat). */
import { ArrowUp, ChevronDown, Paperclip, Plus, Sparkles, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useLocation } from "react-router";
import { usePutSettings, useSettings } from "../api/queries";
import type { Model } from "../api/types";
import { elegirVideo, enTauri } from "../dialogo";
import { nueva, useConversaciones } from "../state/conversations";
import { Button, DropdownMenu, IconButton, toast } from "../ui";
import { ApprovalCard } from "./ApprovalCard";
import s from "./ChatScreen.module.css";
import { GrupoPasos } from "./ToolBlock";
import { Markdown } from "./Markdown";
import { nombreModelo, precioModelo } from "./modelos";
import { costeUsd, type BloqueTool, type Turno } from "./turno";
import { useChat, type Mensaje } from "./useChat";

const ALTO_MAXIMO_COMPOSITOR = 168;

export function ChatScreen() {
  const chat = useChat(useConversaciones((st) => st.activa));
  const settings = useSettings();
  const guardarAjustes = usePutSettings();
  const [texto, setTexto] = useState("");
  const [usarKb, setUsarKb] = useState(true);
  const lista = useRef<HTMLDivElement>(null);
  const campo = useRef<HTMLTextAreaElement>(null);
  const location = useLocation();

  // Otra pantalla (Panel de canal) puede llegar con un mensaje inicial en el estado de navegación.
  const inicial = useRef<string | undefined>((location.state as { mensaje?: string } | null)?.mensaje);
  useEffect(() => {
    const m = inicial.current;
    if (!m) return;
    inicial.current = undefined;
    window.history.replaceState({}, "");
    void chat.enviar(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    lista.current?.scrollTo({ top: lista.current.scrollHeight });
  }, [chat.mensajes]);

  // El campo crece con el texto hasta un máximo y entonces hace scroll.
  useLayoutEffect(() => {
    const el = campo.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, ALTO_MAXIMO_COMPOSITOR)}px`;
  }, [texto]);

  const modelo = settings.data?.model ?? "claude-opus-5-5";
  const coste = useMemo(() => {
    let usd = 0;
    let cache = 0;
    for (const m of chat.mensajes) {
      if (m.role !== "assistant") continue;
      usd += costeUsd(modelo, m.turno.usage);
      cache += m.turno.usage?.cache_read_input_tokens ?? 0;
    }
    return { usd, cache, hay: chat.mensajes.some((m) => m.role === "assistant" && m.turno.usage) };
  }, [chat.mensajes, modelo]);

  const enviar = (e?: FormEvent) => {
    e?.preventDefault();
    if (chat.enStream) return;
    const t = texto.trim();
    if (!t) return;
    setTexto("");
    void chat.enviar(t, { sinKb: !usarKb });
  };
  const teclas = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      enviar();
    }
  };

  const adjuntar = async () => {
    if (!enTauri()) {
      toast({ title: "El explorador de archivos solo está en la aplicación de escritorio", description: "Escribe la ruta del vídeo en el mensaje.", tone: "error" });
      return;
    }
    try {
      const ruta = await elegirVideo(settings.data?.allowed_dirs[0]?.path ?? "");
      if (ruta) {
        setTexto((t) => (t ? `${t}\n${ruta}` : ruta));
        campo.current?.focus();
      }
    } catch (e) {
      toast({ title: "No se pudo abrir el explorador", description: String((e as Error)?.message ?? e), tone: "error" });
    }
  };

  return (
    <div className={s.chat}>
      <header className={s.cabecera} data-testid="chat-header">
        <h1 className={s.titulo}>{chat.titulo || "Nueva conversación"}</h1>
        <DropdownMenu
          trigger={
            <button type="button" className={s.pastilla} data-testid="chat-modelo" aria-label={`Modelo: ${nombreModelo(modelo)}`}>
              {nombreModelo(modelo)}
              <ChevronDown aria-hidden size="0.9em" />
            </button>
          }
          label="Modelo"
          radio={{ value: modelo, onValueChange: (m) => guardarAjustes.mutate({ model: m as Model }) }}
          items={(settings.data?.models ?? [modelo]).map((m) => ({ value: m, label: nombreModelo(m), description: precioModelo(m) }))}
        />
        {coste.hay && (
          <span className={s.coste} data-testid="chat-coste" title="Coste estimado de esta conversación">
            ≈ ${coste.usd.toFixed(4)} · {coste.cache.toLocaleString("es-ES")} tokens en caché
          </span>
        )}
        <Button size="sm" icon={Plus} data-testid="chat-nueva" onClick={() => nueva()}>
          Nueva
        </Button>
      </header>

      <div className={s.mensajes} data-testid="chat-mensajes" ref={lista}>
        <div className={s.hilo}>
          {chat.mensajes.length === 0 && (
            <p className={s.vacio} data-testid="chat-vacio">
              Pregunta al agente o pídele que publique un vídeo.
            </p>
          )}
          {chat.mensajes.map((m, i) => (
            <MensajeView key={i} m={m} onResolver={chat.resolver} />
          ))}
        </div>
      </div>

      <form className={s.formulario} data-testid="chat-form" onSubmit={enviar}>
        <div className={s.compositor}>
          <label htmlFor="chat-mensaje" className={s.soloLectores}>
            Mensaje
          </label>
          <textarea
            id="chat-mensaje"
            ref={campo}
            data-testid="chat-input"
            className={s.campo}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={teclas}
            disabled={chat.enStream}
            rows={1}
            placeholder="Pregunta algo al agente o pídele una acción"
          />
          <div className={s.herramientas}>
            <IconButton icon={Paperclip} size="sm" variant="secondary" aria-label="Adjuntar vídeo" data-testid="chat-adjuntar" onClick={() => void adjuntar()} disabled={chat.enStream} />
            <button type="button" role="switch" aria-checked={usarKb} className={s.interruptor} data-testid="chat-usar-kb" onClick={() => setUsarKb(!usarKb)}>
              Usar KB · {usarKb ? "sí" : "no"}
            </button>
            <span className={s.ayuda}>Enter envía · Shift+Enter salto</span>
            {chat.enStream ? (
              <IconButton icon={Square} size="sm" variant="secondary" aria-label="Cancelar" data-testid="chat-cancelar" onClick={chat.cancelar} />
            ) : (
              <IconButton icon={ArrowUp} size="sm" variant="primary" aria-label="Enviar" type="submit" data-testid="chat-enviar" disabled={!texto.trim()} />
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

function MensajeView({ m, onResolver }: { m: Mensaje; onResolver: ReturnType<typeof useChat>["resolver"] }) {
  if (m.role === "user") {
    return (
      <article className={s.usuario} data-testid="msg-user">
        {m.text}
      </article>
    );
  }
  return (
    <article className={s.agente} data-testid="msg-assistant">
      <div className={s.avatar} aria-hidden>
        <Sparkles size="1em" />
      </div>
      <div className={s.contenido}>
        <TurnoView turno={m.turno} onResolver={onResolver} />
      </div>
    </article>
  );
}

type Trozo = { tipo: "texto"; texto: string; ultimo: boolean } | { tipo: "pasos"; bloques: BloqueTool[] };

/** Texto y grupos de pasos en el orden en que llegaron: las tools consecutivas forman un grupo. */
function trocear(turno: Turno): Trozo[] {
  const trozos: Trozo[] = [];
  turno.bloques.forEach((b, i) => {
    if (b.kind === "text") {
      trozos.push({ tipo: "texto", texto: b.text, ultimo: i === turno.bloques.length - 1 });
      return;
    }
    const previo = trozos[trozos.length - 1];
    if (previo?.tipo === "pasos") previo.bloques.push(b);
    else trozos.push({ tipo: "pasos", bloques: [b] });
  });
  return trozos;
}

export function TurnoView({ turno, onResolver, sinAprobaciones }: { turno: Turno; onResolver: ReturnType<typeof useChat>["resolver"]; sinAprobaciones?: boolean }) {
  return (
    <>
      {trocear(turno).map((t, i) =>
        t.tipo === "texto" ? (
          <div className={s.texto} data-testid="bloque-texto" key={i}>
            <Markdown text={t.texto} />
            {turno.estado === "streaming" && t.ultimo && <span className={s.cursor}>▍</span>}
          </div>
        ) : (
          <div className={s.pasos} key={i}>
            <GrupoPasos bloques={t.bloques} />
            {t.bloques.map(
              (b) =>
                !sinAprobaciones && b.approval?.status === "pending" && <ApprovalCard key={b.approval.id} approval={b.approval} onResolver={(d, c) => onResolver(b.approval!, d, c)} />,
            )}
          </div>
        ),
      )}
      {turno.estado === "streaming" && turno.bloques.length === 0 && <span className={s.cursor}>▍</span>}
      {turno.estado === "error" && (
        <div className={s.error} data-testid="turno-error" role="alert">
          Error: {turno.error}
          {turno.error?.includes("clave de Anthropic") && (
            <>
              {" "}
              <Link to="/ajustes" data-testid="chat-ir-ajustes">
                Ir a Ajustes
              </Link>
            </>
          )}
        </div>
      )}
    </>
  );
}
