import type { HTMLAttributes } from "react";
import s from "./Card.module.css";
import { cx } from "./cx";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: "div" | "section" | "article";
  /** Borde y elevación de acento para destacar (p. ej. una propuesta pendiente). */
  raised?: boolean;
}

export function Card({ as: Tag = "div", raised, className, ...rest }: CardProps) {
  return <Tag {...rest} className={cx(s.card, raised && s.raised, className)} />;
}
