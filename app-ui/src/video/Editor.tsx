/** Marco del editor (D6, layout B): cabecera de 48 px, preview a la izquierda, panel de 320 px a la
 *  derecha y timeline de 240 px a todo el ancho. Las cuatro ranuras (`Preview`, `Panel`, `Timeline`,
 *  `RenderBoton`) las rellenan T17, T18, T19 y T20; todas leen el store del editor, sin props.
 *  Todo texto del proyecto se pinta como texto. */
import { ArrowLeft, Redo2, Undo2 } from "lucide-react";
import { useEffect } from "react";
import { Link } from "react-router";
import {
  deshacer,
  descartarBorrador,
  rehacer,
  usarBorrador,
  useEditor,
  type EstadoGuardado,
} from "../state/editor";
import { Button, IconButton } from "../ui";
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
    t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)
  );
}

export function Editor() {
  const titulo = useEditor((e) => e.proyecto?.titulo ?? "");
  const guardado = useEditor((e) => e.guardado);
  const conflicto = useEditor((e) => e.conflicto);
  const hayDeshacer = useEditor((e) => e.historial.length > 0);
  const hayRehacer = useEditor((e) => e.futuro.length > 0);

  useEffect(() => {
    const alTeclar = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || enCampoDeTexto(ev.target))
        return;
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
            disabled={!hayDeshacer}
            onClick={deshacer}
          />
          <IconButton
            icon={Redo2}
            size="sm"
            variant="ghost"
            aria-label="Rehacer"
            data-testid="editor-rehacer"
            disabled={!hayRehacer}
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
            <Button size="sm" variant="ghost" onClick={descartarBorrador}>
              Descartar la mía
            </Button>
          </div>
        )}
      </div>
      <div className={s.cuerpo}>
        <div className={s.zonaPreview} data-testid="editor-zona-preview">
          <Preview />
        </div>
        <aside className={s.zonaPanel} data-testid="editor-zona-panel">
          <Panel />
        </aside>
      </div>
      <div className={s.zonaTimeline} data-testid="editor-zona-timeline">
        <Timeline />
      </div>
    </div>
  );
}
