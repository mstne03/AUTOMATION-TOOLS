/** Enlaces externos. El WebView solo tiene `core:default`, así que abrir el navegador del sistema
 *  lo hace Rust (`abrir_url` en src-tauri/src/lib.rs), que solo acepta https://.
 *  Fuera de Tauri (E2E, `pnpm dev`) el enlace se comporta como un <a target="_blank"> normal. */
import { invoke } from "@tauri-apps/api/core";
import type { MouseEvent, ReactNode } from "react";

const enTauri = () => "__TAURI_INTERNALS__" in window;

/** Misma regla que `url_https_valida` en Rust: solo https y sin espacios ni caracteres de control. */
export const esUrlHttps = (url: string) => /^https:\/\/[^\s\u0000-\u001f]+$/.test(url);

export async function abrirUrl(url: string): Promise<void> {
  if (!esUrlHttps(url)) throw new Error("Solo se abren enlaces https://");
  await invoke("abrir_url", { url });
}

/** Las URLs que escribe el modelo pueden ser cualquier cosa: lo que no sea https se pinta como texto. */
export function EnlaceExterno({ href, children }: { href: string; children: ReactNode }) {
  if (!esUrlHttps(href)) return <span>{children}</span>;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!enTauri()) return;
    e.preventDefault();
    abrirUrl(href).catch((err) => console.error("abrir_url:", err));
  };
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>
      {children}
    </a>
  );
}
