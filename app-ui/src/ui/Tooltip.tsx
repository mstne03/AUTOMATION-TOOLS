/** Tooltip sobre Radix: aparece con foco de teclado además de con el ratón. No sustituye a un
 *  aria-label: es una ayuda visual, el nombre accesible lo da el propio control. */
import * as R from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import s from "./overlay.module.css";

export function Tooltip({ content, children }: { content: string; children: ReactNode }) {
  return (
    <R.Provider delayDuration={300}>
      <R.Root>
        <R.Trigger asChild>{children}</R.Trigger>
        <R.Portal>
          <R.Content className={s.tooltip} sideOffset={6}>
            {content}
          </R.Content>
        </R.Portal>
      </R.Root>
    </R.Provider>
  );
}
