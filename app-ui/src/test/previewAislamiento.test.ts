/** La preview se abre y se cierra solo por `sesionPreview()` (pendientes-T16). Sustituye a una regla
 *  ESLint: el proyecto no usa ESLint. */
import { describe, expect, it } from "vitest";

/** Código fuente de `src/` (sin tests), por ruta relativa a `src/`. */
const fuentes = import.meta.glob(["../**/*.ts", "../**/*.tsx", "!../test/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const rutas = Object.keys(fuentes).map((k) => k.replace(/^\.\.\//, ""));

describe("ciclo de vida de la preview", () => {
  it("videoPreviewAbrir/videoPreviewCerrar solo se llaman desde EditorPreview.ts", () => {
    const permitidos = new Set(["api/client.ts", "api/types.ts", "video/EditorPreview.ts"]);
    expect(rutas.length).toBeGreaterThan(50);
    const infractores = rutas.filter(
      (f) => !permitidos.has(f) && /videoPreview(Abrir|Cerrar)/.test(fuentes[`../${f}`]!),
    );
    expect(infractores).toEqual([]);
  });
  it("el cliente y EditorPreview.ts siguen siendo los únicos que los nombran (la regla no está vacía)", () => {
    const f = fuentes["../video/EditorPreview.ts"]!;
    expect(f).toMatch(/videoPreviewAbrir/);
    expect(f).toMatch(/videoPreviewCerrar/);
  });
});
