/** Etiquetas como chips: Enter o coma añade, Backspace con el campo vacío quita la última. */
import { X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { useFieldProps } from "./Field";
import s from "./TagInput.module.css";

export interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function TagInput({ value, onChange, placeholder = "Añadir etiqueta", disabled }: TagInputProps) {
  const [texto, setTexto] = useState("");
  const campo = useFieldProps();

  const añadir = (crudo: string) => {
    const t = crudo.trim().replace(/,+$/, "").trim();
    if (t && !value.some((v) => v.toLowerCase() === t.toLowerCase())) onChange([...value, t]);
    setTexto("");
  };
  const quitar = (i: number) => onChange(value.filter((_, j) => j !== i));

  const teclas = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      añadir(texto);
    } else if (e.key === "Backspace" && texto === "" && value.length > 0) {
      quitar(value.length - 1);
    }
  };

  return (
    <div className={s.caja} data-testid="taginput">
      <ul className={s.lista} aria-label="Etiquetas">
        {value.map((t, i) => (
          <li key={t} className={s.tag}>
            <span>{t}</span>
            <button type="button" className={s.quitar} aria-label={`Quitar ${t}`} disabled={disabled} onClick={() => quitar(i)}>
              <X aria-hidden size="1em" />
            </button>
          </li>
        ))}
      </ul>
      <input
        {...campo}
        className={s.entrada}
        value={texto}
        disabled={disabled}
        placeholder={value.length === 0 ? placeholder : ""}
        onChange={(e) => setTexto(e.target.value)}
        onKeyDown={teclas}
        onBlur={() => añadir(texto)}
      />
    </div>
  );
}
