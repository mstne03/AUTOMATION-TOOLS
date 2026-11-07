/** Marco del editor (D6, layout B): cabecera de 48 px, preview a la izquierda, panel de 320 px a la
 *  derecha y timeline de 240 px a todo el ancho. Las cuatro ranuras (`Preview`, `Panel`, `Timeline`,
 *  `RenderBoton`) las rellenan T17, T18, T19 y T20; todas leen el store del editor, sin props.
 *  Todo texto del proyecto se pinta como texto. */
import { ArrowLeft, Redo2, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  deshacer,
  descartarBorrador,
  rehacer,
  usarBorrador,
  useEditor,
  type EstadoGuardado,
} from "../state/editor";
import { Button, ConfirmDialog, IconButton } from "../ui";
import s from "./Editor.module.css";
import { Preview } from "./Preview";
import { Panel } from "./panel/Panel";
import { RenderBoton } from "./render/RenderBoton";
import { Timeline } from "./timeline/Timeline";

const TEXTO_GUARDADO: Record<EstadoGuardado, string> = {
  guardado: "Guardado",
  pendiente: "Guardando…",
  guardando: "Guardando…",
  error: "Error al guardar",
};

/** Ctrl+Z / Ctrl+Y no deben quitarle el deshacer nativo a un campo de texto. */
function enCampoDeTexto(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) ||
    t.getAttribute("role") === "textbox"
  );
}

/** Con un diálogo abierto, los atajos del editor no deben actuar sobre lo que hay detrás. */
function hayDialogoAbierto(t: EventTarget | null): boolean {
  const SEL = '[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
  if (t instanceof Element && t.closest(SEL)) return true;
  return document.querySelector(SEL) !== null;
}

export function Editor() {
  const [confirmarDescarte, setConfirmarDescarte] = useState(false);
  const titulo = useEditor((e) => e.proyecto?.titulo ?? "");
  const guardado = useEditor((e) => e.guardado);
  const conflicto = useEditor((e) => e.conflicto);
  const hayDeshacer = useEditor((e) => e.historial.length > 0);
  const hayRehacer = useEditor((e) => e.futuro.length > 0);

  useEffect(() => {
    const alTeclar = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.defaultPrevented || ev.isComposing)
        return;
      if (enCampoDeTexto(ev.target) || hayDialogoAbierto(ev.target)) return;
      // Con el aviso de conflicto no se edita (el cuerpo es inerte): tampoco por teclado.
      if (useEditor.getState().conflicto) return;
      const k = ev.key.toLowerCase();
      if (k === "z" && !ev.shiftKey) deshacer();
      else if (k === "y" || (k === "z" && ev.shiftKey)) rehacer();
      else return;
      ev.preventDefault();
    };
    window.addEventListener("keydown", alTeclar);
    return () => window.removeEventListener("keydown", alTeclar);
  }, []);

  return (
    <div className={s.editor} data-testid="editor">
      <div className={s.superior}>
        <header className={s.cabecera}>
          <Link
            to="/video"
            className={s.volver}
            data-testid="editor-volver"
            aria-label="Volver a la lista de vídeos"
          >
            <ArrowLeft aria-hidden size="1.1em" />
          </Link>
          <h1 className={s.titulo} data-testid="editor-titulo">
            {titulo}
          </h1>
          <span
            className={s.guardado}
            data-testid="editor-guardado"
            data-estado={guardado}
            aria-live="polite"
          >
            {TEXTO_GUARDADO[guardado]}
          </span>
          <IconButton
            icon={Undo2}
            size="sm"
            variant="ghost"
            aria-label="Deshacer"
            data-testid="editor-deshacer"
            disabled={!hayDeshacer || conflicto}
            onClick={deshacer}
          />
          <IconButton
            icon={Redo2}
            size="sm"
            variant="ghost"
            aria-label="Rehacer"
            data-testid="editor-rehacer"
            disabled={!hayRehacer || conflicto}
            onClick={rehacer}
          />
          <RenderBoton />
        </header>
        {conflicto && (
          <div
            className={s.conflicto}
            role="alert"
            data-testid="editor-conflicto"
          >
            <span>
              Otra sesión guardó este proyecto antes. Se ha cargado la versión
              guardada; tu edición se conserva aparte.
            </span>
            <Button size="sm" variant="primary" onClick={usarBorrador}>
              Recuperar mi edición
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmarDescarte(true)}>
              Descartar la mía
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmarDescarte && conflicto}
        onOpenChange={setConfirmarDescarte}
        title="¿Descartar tu edición?"
        description="Tu edición local se perderá y te quedarás con la versión guardada."
        confirmLabel="Descartar"
        tone="danger"
        onConfirm={descartarBorrador}
      />
      <div className={s.cuerpo} inert={conflicto}>
        <div className={s.zonaPreview} data-testid="editor-zona-preview">
          <Preview />
        </div>
        <aside className={s.zonaPanel} data-testid="editor-zona-panel">
          <Panel />
        </aside>
      </div>
      <div
        className={s.zonaTimeline}
        data-testid="editor-zona-timeline"
        inert={conflicto}
      >
        <Timeline />
      </div>
    </div>
  );
}
