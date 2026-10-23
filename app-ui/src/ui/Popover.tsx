import * as R from "@radix-ui/react-popover";
import type { ReactNode } from "react";
import { cx } from "./cx";
import s from "./overlay.module.css";

export interface PopoverProps {
  trigger: ReactNode;
  /** Nombre accesible del panel. */
  label: string;
  children: ReactNode;
  align?: "start" | "center" | "end";
}

export function Popover({ trigger, label, children, align = "start" }: PopoverProps) {
  return (
    <R.Root>
      <R.Trigger asChild>{trigger}</R.Trigger>
      <R.Portal>
        <R.Content className={cx(s.panel, s.popover)} align={align} sideOffset={6} aria-label={label}>
          {children}
        </R.Content>
      </R.Portal>
    </R.Root>
  );
}
