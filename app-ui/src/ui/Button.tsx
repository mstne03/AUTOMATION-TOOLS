import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import s from "./Button.module.css";
import { cx } from "./cx";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Muestra un spinner, deshabilita el botón y lo marca como ocupado. */
  loading?: boolean;
  /** Icono a la izquierda del texto (import por icono de lucide-react). */
  icon?: LucideIcon;
}

export function Button({ variant = "secondary", size = "md", loading, icon: Icon, className, children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(s.button, s[variant], s[size], className)}
    >
      {loading ? <Spinner label="Procesando" /> : Icon && <Icon aria-hidden size="1.25em" />}
      {children}
    </button>
  );
}
