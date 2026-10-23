/** Sustituye respuestas concretas del sidecar (p. ej. un canal autorizado con datos) sin tocar el
 *  resto: el sidecar de los E2E no tiene OAuth real. Responde también al preflight de CORS. */
import type { Page } from "@playwright/test";

const CORS = {
  "access-control-allow-origin": "http://localhost:1420",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
};

export interface Peticion {
  metodo: string;
  cuerpo: unknown;
}

/** `rutas`: ruta (sin query) -> cuerpo JSON, o función (url, petición) => [status, cuerpo]. */
export async function simularRutas(page: Page, rutas: Record<string, unknown | ((url: URL, p: Peticion) => [number, unknown])>) {
  const llamadas: Record<string, number> = {};
  await page.route(/127\.0\.0\.1:\d+\//, async (route) => {
    const url = new URL(route.request().url());
    const r = rutas[url.pathname];
    if (r === undefined) return route.continue();
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    llamadas[url.pathname] = (llamadas[url.pathname] ?? 0) + 1;
    const peticion: Peticion = { metodo: route.request().method(), cuerpo: route.request().postDataJSON?.() ?? null };
    const [status, cuerpo] = typeof r === "function" ? (r as (u: URL, p: Peticion) => [number, unknown])(url, peticion) : [200, r];
    return route.fulfill({ status, headers: CORS, contentType: "application/json", body: JSON.stringify(cuerpo) });
  });
  return llamadas;
}
