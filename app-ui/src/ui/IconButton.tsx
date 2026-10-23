import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import s from "./IconButton.module.css";
import { cx } from "./cx";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> {
  icon: LucideIcon;
  /** Obligatorio: un botón con solo un icono no tiene nombre accesible. */
  "aria-label": string;
  /** xs 30 · sm 32 · md 36 · lg 44 */
  size?: "xs" | "sm" | "md" | "lg";
  variant?: "secondary" | "ghost" | "primary" | "danger";
}

export function IconButton({ icon: Icon, size = "md", variant = "secondary", className, type = "button", ...rest }: IconButtonProps) {
  if (import.meta.env.DEV && !rest["aria-label"]?.trim()) {
    throw new Error("IconButton necesita aria-label: un botón con solo un icono no tiene nombre accesible.");
  }
  return (
    <button {...rest} type={type} className={cx(s.icon, s[size], s[variant], className)}>
      <Icon aria-hidden size="1.15em" />
    </button>
  );
}
