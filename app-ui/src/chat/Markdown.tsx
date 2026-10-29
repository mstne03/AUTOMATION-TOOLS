/** Markdown que emite el modelo (párrafos, cabeceras, listas, tablas, citas, bloques de código,
 *  **negrita**, *cursiva*, `código`, enlaces y URLs), renderizado SIEMPRE como elementos React:
 *  nunca innerHTML, porque la salida del modelo es entrada no confiable (un <img onerror> sale
 *  como texto). Las URLs https se pintan como chips "n · dominio ↗" que abren con abrir_url. */
import type { ReactNode } from "react";
import { EnlaceExterno, esUrlHttps } from "../enlaces";
import s from "./Markdown.module.css";

type Alineacion = "left" | "center" | "right" | undefined;

type Bloque =
  | { t: "p"; lineas: string[] }
  | { t: "h"; nivel: number; texto: string }
  | { t: "lista"; ordenada: boolean; items: string[] }
  | { t: "code"; lang: string; texto: string }
  | { t: "quote"; lineas: string[] }
  | { t: "table"; cab: string[]; filas: string[][]; alin: Alineacion[] }
  | { t: "hr" };

const reItem = /^\s*(?:[-*+•]|\d+[.)])\s+/;
const reSeparadorTabla = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function celdas(linea: string): string[] {
  return linea
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .replace(/\\\|/g, "\u0000")
    .split("|")
    .map((c) => c.replace(/\u0000/g, "|").trim());
}

export function parsear(texto: string): Bloque[] {
  const lineas = texto.replace(/\r\n/g, "\n").split("\n");
  const bloques: Bloque[] = [];
  let i = 0;
  while (i < lineas.length) {
    const l = lineas[i];
    if (l.trim() === "") {
      i++;
      continue;
    }
    const valla = l.match(/^\s*```+\s*([\w-]*)/);
    if (valla) {
      const cuerpo: string[] = [];
      i++;
      while (i < lineas.length && !/^\s*```+\s*$/.test(lineas[i])) cuerpo.push(lineas[i++]);
      i++; // cierre (o fin del texto si el modelo no la cerró)
      bloques.push({ t: "code", lang: valla[1], texto: cuerpo.join("\n") });
      continue;
    }
    const cab = l.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (cab) {
      bloques.push({ t: "h", nivel: cab[1].length, texto: cab[2] });
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) {
      bloques.push({ t: "hr" });
      i++;
      continue;
    }
    if (l.includes("|") && i + 1 < lineas.length && reSeparadorTabla.test(lineas[i + 1]) && lineas[i + 1].includes("-")) {
      const encabezado = celdas(l);
      const alin: Alineacion[] = celdas(lineas[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : undefined));
      i += 2;
      const filas: string[][] = [];
      while (i < lineas.length && lineas[i].trim() !== "" && lineas[i].includes("|")) filas.push(celdas(lineas[i++]));
      bloques.push({ t: "table", cab: encabezado, filas, alin });
      continue;
    }
    if (/^\s*>/.test(l)) {
      const cuerpo: string[] = [];
      while (i < lineas.length && /^\s*>/.test(lineas[i])) cuerpo.push(lineas[i++].replace(/^\s*>\s?/, ""));
      bloques.push({ t: "quote", lineas: cuerpo });
      continue;
    }
    if (reItem.test(l)) {
      const ordenada = /^\s*\d/.test(l);
      const items: string[] = [];
      while (i < lineas.length && reItem.test(lineas[i]) && /^\s*\d/.test(lineas[i]) === ordenada) items.push(lineas[i++].replace(reItem, ""));
      bloques.push({ t: "lista", ordenada, items });
      continue;
    }
    const parrafo: string[] = [];
    while (i < lineas.length && lineas[i].trim() !== "" && !/^\s*```/.test(lineas[i]) && !/^\s{0,3}#{1,6}\s/.test(lineas[i]) && !/^\s*>/.test(lineas[i]) && !reItem.test(lineas[i])) {
      if (lineas[i].includes("|") && i + 1 < lineas.length && reSeparadorTabla.test(lineas[i + 1]) && lineas[i + 1].includes("-")) break;
      parrafo.push(lineas[i++]);
    }
    if (parrafo.length === 0) parrafo.push(lineas[i++]); // línea que ningún caso reconoce: no se pierde
    bloques.push({ t: "p", lineas: parrafo });
  }
  return bloques;
}

const TOKEN = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>]+)/g;

/** Numeración de las fuentes: la misma URL siempre lleva el mismo número dentro de un mensaje. */
type Citas = Map<string, number>;

function dominio(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function inline(texto: string, citas: Citas = new Map()): ReactNode[] {
  return texto.split(TOKEN).map((parte, i) => {
    if (parte.startsWith("**") && parte.endsWith("**") && parte.length > 4) return <strong key={i}>{inline(parte.slice(2, -2), citas)}</strong>;
    if (parte.startsWith("`") && parte.endsWith("`") && parte.length > 2) return <code key={i}>{parte.slice(1, -1)}</code>;
    if (parte.startsWith("*") && parte.endsWith("*") && parte.length > 2) return <em key={i}>{inline(parte.slice(1, -1), citas)}</em>;
    const enlace = parte.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (enlace) {
      return (
        <EnlaceExterno key={i} href={enlace[2]} className={s.enlace}>
          {enlace[1]}
        </EnlaceExterno>
      );
    }
    if (/^https?:\/\//.test(parte)) {
      // La puntuación final de la frase no forma parte de la URL.
      const url = parte.replace(/[.,;:!?)\]]+$/, "");
      const resto = parte.slice(url.length);
      if (!citas.has(url)) citas.set(url, citas.size + 1);
      return (
        <span key={i}>
          {esUrlHttps(url) ? (
            <EnlaceExterno href={url} className={s.cita}>
              {citas.get(url)} · {dominio(url)} ↗
            </EnlaceExterno>
          ) : (
            url
          )}
          {resto}
        </span>
      );
    }
    return parte;
  });
}

function conSaltos(lineas: string[], citas: Citas): ReactNode[] {
  return lineas.map((l, j) => (
    <span key={j}>
      {j > 0 && <br />}
      {inline(l, citas)}
    </span>
  ));
}

export function Markdown({ text }: { text: string }) {
  const citas: Citas = new Map();
  return (
    <div className={s.md}>
      {parsear(text).map((b, i) => {
        switch (b.t) {
          case "p":
            return <p key={i}>{conSaltos(b.lineas, citas)}</p>;
          case "h": {
            // Las cabeceras del modelo no compiten con el título de la pantalla (h1): h3–h5.
            const Tag = (b.nivel <= 2 ? "h3" : b.nivel === 3 ? "h4" : "h5") as "h3" | "h4" | "h5";
            return <Tag key={i}>{inline(b.texto, citas)}</Tag>;
          }
          case "lista": {
            const Tag = b.ordenada ? "ol" : "ul";
            return (
              <Tag key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, citas)}</li>
                ))}
              </Tag>
            );
          }
          case "code":
            return (
              <pre key={i} className={s.codigo} data-lang={b.lang || undefined}>
                <code>{b.texto}</code>
              </pre>
            );
          case "quote":
            return <blockquote key={i}>{conSaltos(b.lineas, citas)}</blockquote>;
          case "hr":
            return <hr key={i} />;
          case "table":
            return (
              <div key={i} className={s.tabla} data-testid="md-tabla" tabIndex={0} role="region" aria-label="Tabla">
                <table>
                  <thead>
                    <tr>
                      {b.cab.map((c, j) => (
                        <th key={j} scope="col" data-align={b.alin[j]}>
                          {inline(c, citas)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.filas.map((f, r) => (
                      <tr key={r}>
                        {b.cab.map((_, j) => (
                          <td key={j} data-align={b.alin[j]}>
                            {inline(f[j] ?? "", citas)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
