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

/** Acceso a la API de preview: por nombre, por acceso indirecto (`client["videoPreview" + "Abrir"]`,
 *  desestructuración, plantillas) o por la ruta HTTP directa. */
const ACCESO_API = /videoPreview/;
const RUTA_HTTP = /video\/proyectos[^\n]*\/preview\b/;
export const accedeALaApi = (src: string) => ACCESO_API.test(src) || RUTA_HTTP.test(src);
export const usaLaSesion = (src: string) => /(iniciar|cerrar)SesionPreview/.test(src);

describe("ciclo de vida de la preview", () => {
  it("videoPreviewAbrir/videoPreviewCerrar solo se llaman desde EditorPreview.ts", () => {
    const permitidos = new Set(["api/client.ts", "api/types.ts", "video/EditorPreview.ts"]);
    expect(rutas.length).toBeGreaterThan(50);
    const infractores = rutas.filter((f) => !permitidos.has(f) && accedeALaApi(fuentes[`../${f}`]!));
    expect(infractores).toEqual([]);
  });
  it("iniciarSesionPreview/cerrarSesionPreview solo los usan EditorPreview.ts y la pantalla del editor", () => {
    const permitidos = new Set(["video/EditorPreview.ts", "screens/EditorVideoScreen.tsx"]);
    const infractores = rutas.filter((f) => !permitidos.has(f) && usaLaSesion(fuentes[`../${f}`]!));
    expect(infractores).toEqual([]);
  });
  it("el detector pilla el acceso indirecto", () => {
    expect(accedeALaApi('client["videoPreviewAbrir"](id)')).toBe(true);
    expect(accedeALaApi('client["videoPreview" + "Abrir"](id)')).toBe(true);
    expect(accedeALaApi("const { videoPreviewAbrir } = client;")).toBe(true);
    expect(accedeALaApi("const { videoPreviewCerrar: cerrar } = c;")).toBe(true);
    expect(accedeALaApi("req(`/video/proyectos/${id}/preview`, { method: 'POST' })")).toBe(true);
    expect(accedeALaApi('fetch("/video/proyectos/" + id + "/preview")')).toBe(true);
    expect(accedeALaApi("const x = 1;")).toBe(false);
  });
  it("el cliente y EditorPreview.ts siguen siendo los únicos que los nombran (la regla no está vacía)", () => {
    const f = fuentes["../video/EditorPreview.ts"]!;
    expect(f).toMatch(/videoPreviewAbrir/);
    expect(f).toMatch(/videoPreviewCerrar/);
  });
});
