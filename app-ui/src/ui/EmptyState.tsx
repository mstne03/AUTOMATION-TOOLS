import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import s from "./EmptyState.module.css";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className={s.vacio}>
      {Icon && (
        <div className={s.icono}>
          <Icon aria-hidden size="1.25em" />
        </div>
      )}
      <h3 className={s.titulo}>{title}</h3>
      {description && <p className={s.texto}>{description}</p>}
      {action}
    </div>
  );
}
