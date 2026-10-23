/** Menú desplegable sobre Radix. Dos usos: acciones (`items` con onSelect) o elección única
 *  (`radio`, p. ej. el selector de modelo), con flechas, tipeo y Escape resueltos por Radix. */
import * as R from "@radix-ui/react-dropdown-menu";
import { Check, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import s from "./overlay.module.css";

export interface MenuItem {
  value: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  disabled?: boolean;
  /** Solo en menús de acciones. */
  onSelect?: () => void;
}

export interface DropdownMenuProps {
  /** Elemento que abre el menú (un Button o IconButton; se le pasa el foco y los aria-*). */
  trigger: ReactNode;
  items: MenuItem[];
  /** Cabecera del menú ("Modelo"). */
  label?: string;
  /** Menú de elección única: marca la opción activa y avisa del cambio. */
  radio?: { value: string; onValueChange: (value: string) => void };
  align?: "start" | "center" | "end";
}

export function DropdownMenu({ trigger, items, label, radio, align = "end" }: DropdownMenuProps) {
  const contenido = (it: MenuItem) => (
    <>
      {it.icon && <it.icon aria-hidden size="1.15em" />}
      <span className={s.itemTexto}>
        {it.label}
        {it.description && <span className={s.itemAyuda}>{it.description}</span>}
      </span>
    </>
  );
  return (
    <R.Root>
      <R.Trigger asChild>{trigger}</R.Trigger>
      <R.Portal>
        <R.Content className={s.panel} align={align} sideOffset={6}>
          {label && <R.Label className={s.etiqueta}>{label}</R.Label>}
          {radio ? (
            <R.RadioGroup value={radio.value} onValueChange={radio.onValueChange}>
              {items.map((it) => (
                <R.RadioItem key={it.value} value={it.value} disabled={it.disabled} className={s.item}>
                  {contenido(it)}
                  <R.ItemIndicator className={s.check}>
                    <Check aria-hidden size="1.15em" />
                  </R.ItemIndicator>
                </R.RadioItem>
              ))}
            </R.RadioGroup>
          ) : (
            items.map((it) => (
              <R.Item key={it.value} disabled={it.disabled} className={s.item} onSelect={it.onSelect}>
                {contenido(it)}
              </R.Item>
            ))
          )}
        </R.Content>
      </R.Portal>
    </R.Root>
  );
}
