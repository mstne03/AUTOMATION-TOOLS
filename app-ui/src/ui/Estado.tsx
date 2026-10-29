import type { ElementType, ReactNode } from "react";
import { cx } from "./cx";
import s from "./Estado.module.css";

/** Mensaje de carga/error a pantalla completa (arranque, ajustes aún sin cargar). */
export function Estado({ as: Tag = "p", error, children, ...rest }: { as?: ElementType; error?: boolean; children: ReactNode; "data-testid"?: string }) {
  return (
    <Tag {...rest} className={cx(s.estado, error && s.error)}>
      {children}
    </Tag>
  );
}
