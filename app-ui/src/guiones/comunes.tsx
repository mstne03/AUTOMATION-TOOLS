/** Piezas compartidas por los tres modos de Guiones. */
import { useEffect } from "react";
import { TurnoView } from "../chat/ChatScreen";
import type { useChat } from "../chat/useChat";
import { EnlaceExterno } from "../enlaces";
import { SegmentedControl } from "../ui";
import s from "./Guiones.module.css";
import { dominio, type Formato, type Fuente } from "./modelo";

type Chat = ReturnType<typeof useChat>;

/** Cuando termina el turno que se esperaba, entrega su texto (null si acabó en error). Vive en el
 *  componente, como en Publicar: si se cambia de pantalla a mitad, se procesa al volver. */
export function useAlTerminarTurno(chat: Chat, esperando: boolean, alTerminar: (texto: string | null) => void) {
  useEffect(() => {
    if (!esperando || chat.enStream) return;
    const ultimo = chat.mensajes[chat.mensajes.length - 1];
    if (ultimo?.role !== "assistant" || ultimo.turno.estado === "streaming") return;
    alTerminar(ultimo.turno.estado === "error" ? null : ultimo.turno.bloques.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n"));
  }, [chat.mensajes, chat.enStream, esperando, alTerminar]);
}

export function SelectorFormato({ testid, valor, onChange }: { testid: string; valor: Formato; onChange: (f: Formato) => void }) {
  return (
    <div className={s.campo}>
      <span className={s.etiqueta}>Formato</span>
      <SegmentedControl
        aria-label="Formato"
        data-testid={testid}
        value={valor}
        onChange={onChange}
        options={[
          { value: "long", label: "Vídeo largo" },
          { value: "short", label: "Short" },
        ]}
      />
    </div>
  );
}

export function AvisoJson({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <p className={s.aviso} data-testid="guion-json-error" role="alert">
      No se pudo leer la respuesta del agente como guion. Abajo tienes su texto completo.
    </p>
  );
}

export function Fuentes({ fuentes }: { fuentes: Fuente[] }) {
  if (!fuentes.length) return null;
  return (
    <section className={s.panel} data-testid="guion-fuentes" aria-labelledby="guion-fuentes-titulo">
      <span id="guion-fuentes-titulo" className={s.panelTitulo}>
        Fuentes
      </span>
      <ul className={s.fuentes}>
        {fuentes.map((f) => (
          <li key={f.url}>
            <EnlaceExterno href={f.url}>{f.titulo || dominio(f.url)} ↗</EnlaceExterno>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Respuestas del agente del modo, con la misma vista que el chat (texto, pasos y aprobaciones). */
export function Turnos({ chat, testid }: { chat: Chat; testid: string }) {
  if (!chat.mensajes.some((m) => m.role === "assistant")) return null;
  return (
    <section className={s.turnos} data-testid={testid} aria-label="Respuesta del agente">
      {chat.mensajes.map((m, i) =>
        m.role === "assistant" ? (
          <article className={s.turno} data-testid="msg-assistant" key={i}>
            <TurnoView turno={m.turno} onResolver={chat.resolver} />
          </article>
        ) : null,
      )}
    </section>
  );
}

/** Panel lateral con texto de ayuda. */
export function Ayuda({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className={s.panel} aria-label={titulo}>
      <span className={s.panelTitulo}>{titulo}</span>
      <div className={s.ayuda}>{children}</div>
    </section>
  );
}
