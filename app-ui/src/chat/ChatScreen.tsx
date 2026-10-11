/** Pantalla de chat (docs/pantallas.md → Chat). */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { useClient } from "../api/context";
import { ToolBlock } from "./ToolBlock";
import { costeUsd, type Turno } from "./turno";
import { useChat, type Mensaje } from "./useChat";

export function ChatScreen() {
  const client = useClient();
  const chat = useChat();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => client.getSettings() });
  const [texto, setTexto] = useState("");
  const lista = useRef<HTMLDivElement>(null);

  useEffect(() => {
    lista.current?.scrollTo({ top: lista.current.scrollHeight });
  }, [chat.mensajes]);

  const coste = useMemo(() => {
    const model = settings.data?.model ?? "claude-opus-5-5";
    let usd = 0;
    let cache = 0;
    for (const m of chat.mensajes) {
      if (m.role !== "assistant") continue;
      usd += costeUsd(model, m.turno.usage);
      cache += m.turno.usage?.cache_read_input_tokens ?? 0;
    }
    return { usd, cache, hay: chat.mensajes.some((m) => m.role === "assistant" && m.turno.usage) };
  }, [chat.mensajes, settings.data?.model]);

  const enviar = (e?: FormEvent) => {
    e?.preventDefault();
    if (chat.enStream) return;
    const t = texto.trim();
    if (!t) return;
    setTexto("");
    void chat.enviar(t);
  };
  const teclas = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      enviar();
    }
  };

  return (
    <div className="chat">
      <header className="chat-header" data-testid="chat-header">
        <h1>Chat</h1>
        {coste.hay && (
          <span className="coste" data-testid="chat-coste">
            ≈ ${coste.usd.toFixed(4)} · {coste.cache.toLocaleString("es-ES")} tokens en caché
          </span>
        )}
      </header>
      <div className="chat-mensajes" data-testid="chat-mensajes" ref={lista}>
        {chat.mensajes.length === 0 && (
          <p className="vacio" data-testid="chat-vacio">
            Pregunta al agente o pídele que publique un vídeo.
          </p>
        )}
        {chat.mensajes.map((m, i) => (
          <MensajeView key={i} m={m} onResolver={chat.resolver} />
        ))}
      </div>
      <form className="chat-form" data-testid="chat-form" onSubmit={enviar}>
        <textarea
          data-testid="chat-input"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={teclas}
          disabled={chat.enStream}
          rows={2}
          placeholder="Escribe un mensaje (Enter envía, Shift+Enter salto de línea)"
        />
        {chat.enStream ? (
          <button type="button" data-testid="chat-cancelar" onClick={chat.cancelar}>
            Cancelar
          </button>
        ) : (
          <button type="submit" data-testid="chat-enviar" disabled={!texto.trim()}>
            Enviar
          </button>
        )}
      </form>
    </div>
  );
}

function MensajeView({ m, onResolver }: { m: Mensaje; onResolver: ReturnType<typeof useChat>["resolver"] }) {
  if (m.role === "user") {
    return (
      <article className="msg msg-user" data-testid="msg-user">
        {m.text}
      </article>
    );
  }
  return (
    <article className="msg msg-assistant" data-testid="msg-assistant">
      <TurnoView turno={m.turno} onResolver={onResolver} />
    </article>
  );
}

function TurnoView({ turno, onResolver }: { turno: Turno; onResolver: ReturnType<typeof useChat>["resolver"] }) {
  const ultimo = turno.bloques.length - 1;
  return (
    <>
      {turno.bloques.map((b, i) =>
        b.kind === "text" ? (
          <div className="bloque-texto" data-testid="bloque-texto" key={i}>
            {b.text.split(/\n{2,}/).map((p, j) => (
              <p key={j}>{p}</p>
            ))}
            {turno.estado === "streaming" && i === ultimo && <span className="cursor">▍</span>}
          </div>
        ) : (
          <ToolBlock key={b.id} bloque={b} onResolver={onResolver} />
        ),
      )}
      {turno.estado === "streaming" && turno.bloques.length === 0 && <span className="cursor">▍</span>}
      {turno.estado === "error" && (
        <div className="turno-error" data-testid="turno-error">
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
