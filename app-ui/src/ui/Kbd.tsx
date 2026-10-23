import type { HTMLAttributes } from "react";
import s from "./Kbd.module.css";
import { cx } from "./cx";

export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <kbd {...rest} className={cx(s.kbd, className)} />;
}
