/** Radiogroup accesible: una sola parada de tabulador (la opción activa) y flechas para moverse
 *  y seleccionar, como un radio nativo. */
import type { LucideIcon } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import s from "./SegmentedControl.module.css";
import { cx } from "./cx";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  icon?: LucideIcon;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  "aria-label": string;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function SegmentedControl<T extends string>({ options, value, onChange, disabled, className, ...rest }: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const mover = (desde: number, paso: number | "inicio" | "fin") => {
    const n = options.length;
    const destino = paso === "inicio" ? 0 : paso === "fin" ? n - 1 : (desde + paso + n) % n;
    onChange(options[destino].value);
    refs.current[destino]?.focus();
  };
  const teclas = (e: KeyboardEvent, i: number) => {
    const acciones: Record<string, number | "inicio" | "fin"> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: "inicio", End: "fin" };
    const paso = acciones[e.key];
    if (paso === undefined) return;
    e.preventDefault();
    mover(i, paso);
  };

  return (
    <div role="radiogroup" aria-label={rest["aria-label"]} data-testid={rest["data-testid"]} className={cx(s.grupo, className)}>
      {options.map((o, i) => {
        const activo = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={activo}
            tabIndex={activo ? 0 : -1}
            disabled={disabled || o.disabled}
            className={cx(s.opcion, activo && s.activa)}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => teclas(e, i)}
          >
            {o.icon && <o.icon aria-hidden size="1.25em" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
