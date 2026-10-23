/** Etiqueta + control + ayuda/error + contador `n / max`. Los controles (Input, Textarea, Select,
 *  TagInput) leen el id y los aria-* del contexto, así que basta con anidarlos dentro de <Field>. */
import { createContext, useContext, useId, type ReactNode } from "react";
import s from "./Field.module.css";
import { cx } from "./cx";

interface FieldCtx {
  id: string;
  describedBy?: string;
  invalid: boolean;
}

const Ctx = createContext<FieldCtx | null>(null);

/** Props de accesibilidad que el control hereda del Field que lo envuelve (vacío si no hay). */
export function useFieldProps(): { id?: string; "aria-describedby"?: string; "aria-invalid"?: true } {
  const c = useContext(Ctx);
  if (!c) return {};
  return { id: c.id, "aria-describedby": c.describedBy, "aria-invalid": c.invalid || undefined };
}

export interface FieldProps {
  label: string;
  help?: string;
  error?: string;
  errorTestId?: string;
  /** Contador `count / max`; se marca como error al pasarse. */
  count?: number;
  max?: number;
  className?: string;
  children: ReactNode;
}

export function Field({ label, help, error, errorTestId, count, max, className, children }: FieldProps) {
  const id = useId();
  const pasado = count !== undefined && max !== undefined && count > max;
  const invalid = Boolean(error) || pasado;
  const ids = [help && `${id}-help`, error && `${id}-error`, count !== undefined && `${id}-count`].filter(Boolean).join(" ");
  return (
    <Ctx.Provider value={{ id, describedBy: ids || undefined, invalid }}>
      <div className={cx(s.field, className)}>
        <div className={s.cabecera}>
          <label htmlFor={id} className={s.label}>
            {label}
          </label>
          {count !== undefined && (
            <span id={`${id}-count`} className={cx(s.contador, pasado && s.pasado)} data-testid="field-contador">
              {max !== undefined ? `${count} / ${max}` : count}
            </span>
          )}
        </div>
        {children}
        {help && (
          <p id={`${id}-help`} className={s.ayuda}>
            {help}
          </p>
        )}
        {error && (
          <p id={`${id}-error`} className={s.error} role="alert" data-testid={errorTestId}>
            {error}
          </p>
        )}
      </div>
    </Ctx.Provider>
  );
}
