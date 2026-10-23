import type { LucideIcon } from "lucide-react";
import type { HTMLAttributes } from "react";
import s from "./Chip.module.css";
import { cx } from "./cx";

/** read/write/destructive son los niveles de riesgo de las tools; success e info son estado.
 *  El riesgo se distingue también por luminosidad y por el texto, no solo por el tono. */
export type ChipTone = "read" | "write" | "destructive" | "success" | "info";

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  icon?: LucideIcon;
}

export function Chip({ tone = "read", icon: Icon, className, children, ...rest }: ChipProps) {
  return (
    <span {...rest} data-tone={tone} className={cx(s.chip, s[tone], className)}>
      {Icon && <Icon aria-hidden size="1em" />}
      {children}
    </span>
  );
}
