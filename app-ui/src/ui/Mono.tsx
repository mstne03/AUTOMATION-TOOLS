import type { HTMLAttributes } from "react";
import s from "./Mono.module.css";
import { cx } from "./cx";

/** IDs, rutas y valores técnicos en monoespaciada (I/l/1 y O/0 distinguibles). */
export function Mono({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <code {...rest} className={cx(s.mono, className)} />;
}
