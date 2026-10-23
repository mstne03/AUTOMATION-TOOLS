/** Diálogo modal sobre Radix: foco atrapado, Escape y aria-modal resueltos. El título es
 *  obligatorio (nombre accesible del diálogo); la descripción es opcional. */
import * as R from "@radix-ui/react-dialog";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Button } from "./Button";
import s from "./overlay.module.css";
import { cx } from "./cx";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Pie con las acciones (botones). */
  footer?: ReactNode;
  wide?: boolean;
  children?: ReactNode;
}

export function Dialog({ open, onOpenChange, title, description, footer, wide, children }: DialogProps) {
  // El diálogo es controlado y no lleva Trigger de Radix: devolvemos el foco nosotros al cerrar.
  const origen = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) origen.current = document.activeElement as HTMLElement | null;
  }, [open]);
  return (
    <R.Root open={open} onOpenChange={onOpenChange}>
      <R.Portal>
        <R.Overlay className={s.fondo} />
        {/* sin descripción, aria-describedby={undefined} evita el aviso de Radix */}
        <R.Content
          className={cx(s.dialogo, wide && s.ancho)}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            origen.current?.focus();
          }}
          {...(description ? {} : { "aria-describedby": undefined })}>
          <div>
            <R.Title className={s.titulo}>{title}</R.Title>
            {description ? <R.Description className={s.descripcion}>{description}</R.Description> : null}
          </div>
          {children}
          {footer && <div className={s.acciones}>{footer}</div>}
        </R.Content>
      </R.Portal>
    </R.Root>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger para acciones destructivas (borrar la clave, quitar un canal). */
  tone?: "primary" | "danger";
  onConfirm: () => void | Promise<void>;
}

/** Sustituye a window.confirm: bloquea la interacción hasta decidir y se maneja con teclado. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = "Confirmar", cancelLabel = "Cancelar", tone = "primary", onConfirm }: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={async () => {
              onOpenChange(false);
              await onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
