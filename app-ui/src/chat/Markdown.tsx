/** Subconjunto de Markdown que emite el modelo (párrafos, listas, **negrita**, `código`,
 *  enlaces http), renderizado como elementos React: nunca innerHTML, porque la salida del
 *  modelo es entrada no confiable. ponytail: sin tablas ni cabeceras; añadir si aparecen. */
import type { ReactNode } from "react";

export function Markdown({ text }: { text: string }) {
  const bloques = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  return (
    <>
      {bloques.map((b, i) => {
        const lineas = b.split("\n").filter((l) => l.trim() !== "");
        if (lineas.length && lineas.every((l) => /^\s*[-*•]\s+/.test(l))) {
          return (
            <ul key={i}>
              {lineas.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>
              ))}
            </ul>
          );
        }
        if (lineas.length && lineas.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
          return (
            <ol key={i}>
              {lineas.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>
              ))}
            </ol>
          );
        }
        return (
          <p key={i}>
            {lineas.map((l, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </span>
            ))}
          </p>
        );
      })}
    </>
  );
}

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)]+)/g;

export function inline(s: string): ReactNode[] {
  return s.split(TOKEN).map((parte, i) => {
    if (parte.startsWith("**") && parte.endsWith("**")) return <strong key={i}>{parte.slice(2, -2)}</strong>;
    if (parte.startsWith("`") && parte.endsWith("`")) return <code key={i}>{parte.slice(1, -1)}</code>;
    if (/^https?:\/\//.test(parte)) {
      return (
        <a key={i} href={parte} target="_blank" rel="noopener noreferrer">
          {parte}
        </a>
      );
    }
    return parte;
  });
}
