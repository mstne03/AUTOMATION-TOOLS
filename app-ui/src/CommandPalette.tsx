/** Paleta Ctrl K (cmdk): navegar a cada pantalla y acciones rápidas. El atajo se registra en un
 *  único sitio (useAtajoPaleta), sin listeners globales sueltos por las pantallas. */
import { Command } from "cmdk";
import { BookOpen, ChartLine, MessageSquare, MessageSquarePlus, ScrollText, Search, Settings, Upload } from "lucide-react";
import { useEffect } from "react";
import { create } from "zustand";
import { useNavigate } from "react-router";
import { nueva } from "./state/conversations";
import { setModo } from "./state/guiones";
import s from "./CommandPalette.module.css";
import { Kbd } from "./ui";

/** Ctrl+K (o Cmd+K en macOS) alterna la paleta. */
function useAtajoPaleta(alternar: () => void) {
  useEffect(() => {
    const alPulsar = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        alternar();
      }
    };
    window.addEventListener("keydown", alPulsar);
    return () => window.removeEventListener("keydown", alPulsar);
  }, [alternar]);
}

/** Estado de apertura en un store, para que el botón de la barra lateral (DS-04) abra la paleta
 *  sin pasar estado por props ni registrar otro listener. */
const usePaleta = create<{ abierta: boolean }>(() => ({ abierta: false }));
export const abrirPaleta = () => usePaleta.setState({ abierta: true });
const fijarPaleta = (abierta: boolean) => usePaleta.setState({ abierta });

export function CommandPalette() {
  const abierta = usePaleta((st) => st.abierta);
  const setAbierta = fijarPaleta;
  const navegar = useNavigate();
  useAtajoPaleta(() => fijarPaleta(!usePaleta.getState().abierta));

  const ir = (ruta: string, antes?: () => void) => () => {
    antes?.();
    setAbierta(false);
    navegar(ruta);
  };

  return (
    <Command.Dialog open={abierta} onOpenChange={setAbierta} label="Paleta de comandos" overlayClassName={s.fondo} contentClassName={s.caja} data-testid="paleta">
      <div className={s.buscador}>
        <Search aria-hidden size="1.15em" />
        <Command.Input className={s.entrada} placeholder="Buscar o ejecutar…" data-testid="paleta-input" />
        <Kbd>Esc</Kbd>
      </div>
      <Command.List className={s.lista}>
        <Command.Empty className={s.vacio}>Sin resultados</Command.Empty>
        <Command.Group heading="Ir a" className={s.grupo}>
          <Command.Item className={s.item} onSelect={ir("/chat")} value="Chat">
            <MessageSquare aria-hidden size="1.15em" />
            Chat
          </Command.Item>
          <Command.Item className={s.item} onSelect={ir("/publicar")} value="Publicar vídeo">
            <Upload aria-hidden size="1.15em" />
            Publicar vídeo
          </Command.Item>
          <Command.Item className={s.item} onSelect={ir("/guiones")} value="Guiones">
            <ScrollText aria-hidden size="1.15em" />
            Guiones
          </Command.Item>
          <Command.Item className={s.item} onSelect={ir("/canal")} value="Panel de canal">
            <ChartLine aria-hidden size="1.15em" />
            Panel de canal
          </Command.Item>
          <Command.Item className={s.item} onSelect={ir("/kb")} value="Conocimiento">
            <BookOpen aria-hidden size="1.15em" />
            Conocimiento
          </Command.Item>
          <Command.Item className={s.item} onSelect={ir("/ajustes")} value="Ajustes">
            <Settings aria-hidden size="1.15em" />
            Ajustes
          </Command.Item>
        </Command.Group>
        <Command.Group heading="Acciones" className={s.grupo}>
          <Command.Item className={s.item} onSelect={ir("/chat", () => nueva())} value="Nueva conversación">
            <MessageSquarePlus aria-hidden size="1.15em" />
            Nueva conversación
          </Command.Item>
          <Command.Item className={s.item} onSelect={ir("/publicar")} value="Publicar un vídeo">
            <Upload aria-hidden size="1.15em" />
            Publicar un vídeo
          </Command.Item>
          <Command.Item className={s.item} onSelect={ir("/guiones", () => setModo("escribir"))} value="Escribir un guion">
            <ScrollText aria-hidden size="1.15em" />
            Escribir un guion
          </Command.Item>
          <Command.Item className={s.item} onSelect={ir("/kb")} value="Preguntar a la KB…">
            <BookOpen aria-hidden size="1.15em" />
            Preguntar a la KB…
          </Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
