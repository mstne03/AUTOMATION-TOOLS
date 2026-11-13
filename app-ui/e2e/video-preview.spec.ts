/** Preview aislada del editor (T17, I2, I8). Sidecar y motor reales para el seek y el cambio sin
 *  render; composiciones de fixture (con una CSP de fixture, más corta que la del backend) para las
 *  pruebas de aislamiento, porque ahí hace falta contenido hostil. */
import { expect, test, type Frame, type Page } from "@playwright/test";
import { simularRutas, type Peticion } from "./sidecar-falso";
import { irAlEditor, limpiarVideo, proyectoDeCocina } from "./video-comun";
import { api } from "./api";

const ORIGEN = "http://127.0.0.1:47810";
const CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  `img-src data: blob:; connect-src ${ORIGEN}; frame-ancestors http://localhost:1420 http://tauri.localhost`;

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await limpiarVideo();
});

/** Control mínimo, con el protocolo de T11: `seek { id, t }`, `play`, `pause`. */
const CONTROL = `
let t = 0, rep = false;
const DUR = 10;
addEventListener("message", (e) => {
  const m = e.data;
  if (!m || typeof m !== "object") return;
  if (m.tipo === "seek" && Number.isInteger(m.id) && Number.isFinite(m.t)) {
    t = Math.min(Math.max(0, m.t), DUR);
    document.body.style.background = "hsl(" + Math.round(t * 30) + " 70% 50%)";
    parent.postMessage({ tipo: "seek-hecho", id: m.id, t }, "*");
  } else if (m.tipo === "play") { rep = true; }
  else if (m.tipo === "pause") { rep = false; }
});
parent.postMessage({ tipo: "listo", duracion: DUR }, "*");
`;

const pagina = (script: string, cuerpo = "") =>
  `<!doctype html><meta charset="utf-8"><body>${cuerpo}<script>${script}</script></body>`;

/** Sirve `html` como composición de la preview y simula `POST …/preview` con su URL. */
async function conFixture(
  page: Page,
  id: string,
  html: string,
  extra: Record<string, unknown> = {},
  conCsp = true,
) {
  const llamadas = await simularRutas(page, {
    [`/video/proyectos/${id}/preview`]: (_u: URL, p: Peticion) =>
      p.metodo === "POST"
        ? [200, { url: `${ORIGEN}/p/fixture/index.html`, duracion: 10, avisos: [], fondo: "css", ...extra }]
        : [200, {}],
  });
  await page.route(/127\.0\.0\.1:47810\/p\/fixture\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", headers: { ...(conCsp ? { "content-security-policy": CSP } : {}), "cache-control": "no-store" }, body: html }),
  );
  return llamadas;
}

const marco = (page: Page): Frame => {
  const f = page.frames().find((x) => x.url().startsWith(`${ORIGEN}/p/`));
  if (!f) throw new Error("el iframe de la preview no está cargado");
  return f;
};

/** Lee `window[clave]` del iframe; `undefined` mientras no haya cargado, para que `expect.poll` reintente. */
const leerMarco = (page: Page, clave: string): Promise<unknown> => {
  const f = page.frames().find((x) => x.url().startsWith(`${ORIGEN}/p/`));
  return f ? f.evaluate((k) => (window as unknown as Record<string, unknown>)[k], clave) : Promise.resolve(undefined);
};

test("atributos_exactos: sandbox y allow, sin allow-same-origin", async ({ page }) => {
  const id = await proyectoDeCocina();
  await conFixture(page, id, pagina(CONTROL));
  await irAlEditor(page, id);
  const f = page.getByTestId("preview-marco");
  await expect(f).toHaveAttribute("sandbox", "allow-scripts");
  await expect(f).toHaveAttribute("allow", "autoplay");
  await expect(f).toHaveAttribute("src", `${ORIGEN}/p/fixture/index.html`);
});

test("iframe_sin_token: sin acceso al padre, al almacenamiento ni a Tauri", async ({ page }) => {
  const id = await proyectoDeCocina();
  const sonda = `
    const r = {};
    try { r.padre = typeof parent.document.title; } catch (e) { r.padre = "bloqueado"; }
    try { localStorage.getItem("x"); r.local = "accesible"; } catch (e) { r.local = "lanza"; }
    try { document.cookie; r.cookie = "accesible"; } catch (e) { r.cookie = "lanza"; }
    r.tauri = typeof window.__TAURI__;
    r.origen = self.origin; // origen efectivo: "null" si es opaco (location.origin conserva la URL)
    window.__sonda = r;
  `;
  await conFixture(page, id, pagina(CONTROL + sonda));
  await irAlEditor(page, id);
  await expect(page.getByTestId("preview-marco")).toBeVisible();
  await expect(page.getByTestId("preview-marco")).toHaveAttribute("sandbox", "allow-scripts");
  await expect.poll(() => leerMarco(page, "__sonda")).toEqual({
    padre: "bloqueado",
    local: "lanza",
    cookie: "lanza",
    tauri: "undefined",
    origen: "null",
  });
});

test("sandbox_solo_atributo: sin cabecera CSP, el atributo aísla por sí solo", async ({ page }) => {
  const id = await proyectoDeCocina();
  const sonda = `
    const r = {};
    try { r.padre = typeof parent.document.title; } catch (e) { r.padre = "bloqueado"; }
    try { localStorage.getItem("x"); r.local = "accesible"; } catch (e) { r.local = "lanza"; }
    try { document.cookie; r.cookie = "accesible"; } catch (e) { r.cookie = "lanza"; }
    r.origen = self.origin; // origen efectivo: "null" si es opaco (location.origin conserva la URL)
    window.__sonda = r;
  `;
  await conFixture(page, id, pagina(CONTROL + sonda), {}, false);
  await irAlEditor(page, id);
  const f = page.getByTestId("preview-marco");
  await expect(f).toHaveAttribute("sandbox", "allow-scripts"); // exacto: ni allow-same-origin ni otros
  await expect.poll(() => leerMarco(page, "__sonda")).toEqual({
    padre: "bloqueado",
    local: "lanza",
    cookie: "lanza",
    origen: "null",
  });
});

test("iframe_hostil_no_navega_padre: top.location no cambia la página del editor", async ({ page }) => {
  const id = await proyectoDeCocina();
  const hostil = `try { top.location = "https://evil.example/"; } catch (e) {} try { open("https://evil.example/"); } catch (e) {}`;
  await conFixture(page, id, pagina(CONTROL + hostil));
  const popups: string[] = [];
  page.on("popup", (p) => popups.push(p.url()));
  await irAlEditor(page, id);
  await expect(page.getByTestId("preview-marco")).toBeVisible();
  await page.waitForTimeout(500);
  expect(page.url()).toContain("/#/video/");
  expect(popups).toEqual([]);
  await expect(page.getByTestId("editor")).toBeVisible();
});

test("sonda_red_cero: fetch, WebSocket e imagen externa no salen", async ({ page }) => {
  const id = await proyectoDeCocina();
  const sonda = `
    const r = { fetch: "?", ws: "?", img: "?" };
    fetch("https://evil.example/x").then(() => r.fetch = "salio", () => r.fetch = "bloqueado");
    try { const w = new WebSocket("wss://evil.example/"); w.onopen = () => r.ws = "salio"; w.onerror = () => r.ws = "bloqueado"; } catch (e) { r.ws = "bloqueado"; }
    const i = new Image(); i.onload = () => r.img = "salio"; i.onerror = () => r.img = "bloqueado"; i.src = "https://evil.example/p.png";
    window.__red = r;
  `;
  await conFixture(page, id, pagina(CONTROL + sonda));
  // Chromium emite `request` también para lo que la CSP corta sin salir a la red (falla con "csp"):
  // cuenta como salida cualquier respuesta, o un fallo que no sea de la CSP (p. ej. DNS: sí salió).
  const ajena = (u: string) => !u.startsWith("http://127.0.0.1") && !u.startsWith("http://localhost") && !u.startsWith("data:");
  const externas: string[] = [];
  const cortadas: string[] = [];
  page.on("response", (r) => {
    if (ajena(r.url())) externas.push(r.url());
  });
  page.on("requestfailed", (r) => {
    if (!ajena(r.url())) return;
    if (r.failure()?.errorText === "csp") cortadas.push(r.url());
    else externas.push(r.url());
  });
  await irAlEditor(page, id);
  await expect(page.getByTestId("preview-marco")).toBeVisible();
  await expect
    .poll(() => leerMarco(page, "__red"))
    .toEqual({ fetch: "bloqueado", ws: "bloqueado", img: "bloqueado" });
  expect(externas.filter((u) => u.includes("evil.example"))).toEqual([]);
  expect(cortadas).toContain("https://evil.example/p.png"); // la imagen la corta la CSP, no el DNS
});

test("mensaje_hostil_ignorado: un tipo desconocido del iframe no cambia la UI", async ({ page }) => {
  const id = await proyectoDeCocina();
  const hostil = `parent.postMessage({ tipo: "navegar", url: "https://evil.example/" }, "*");
    parent.postMessage({ tipo: "tiempo", t: 4, reproduciendo: false, html: "<img src=x onerror=alert(1)>" }, "*");`;
  await conFixture(page, id, pagina(CONTROL + hostil));
  await irAlEditor(page, id);
  await expect(page.getByTestId("preview-cargando")).toHaveCount(0);
  await expect(page.getByTestId("preview-tiempo")).toContainText("0:00");
  await expect(page.getByTestId("preview-marco")).not.toHaveAttribute("data-descartados", "0");
});

test("preview_error_visible: un 503 de puerto ocupado se ve en la preview", async ({ page }) => {
  const id = await proyectoDeCocina();
  await simularRutas(page, {
    [`/video/proyectos/${id}/preview`]: (_u: URL, p: Peticion) =>
      p.metodo === "POST" ? [503, { detail: "No hay puerto libre para la preview." }] : [200, {}],
  });
  await irAlEditor(page, id);
  await expect(page.getByTestId("preview-error")).toContainText("puerto");
  await expect(page.getByTestId("preview-marco")).toHaveCount(0);
  await expect(page.getByTestId("editor")).toBeVisible();
});

/** El motor no monta la preview sin voz: se genera con el ElevenLabs falso, confirmando el coste. */
async function generarVoz(id: string) {
  const coste = await api<{ plan: string; caracteres: number }>(`/video/proyectos/${id}/voz/coste`, { method: "POST", body: "{}" });
  const voz = await api<{ generadas: number; fallo?: unknown }>(`/video/proyectos/${id}/voz`, {
    method: "POST",
    body: JSON.stringify({ plan_confirmado: coste.plan, caracteres_confirmados: coste.caracteres }),
  });
  expect(voz.fallo).toBeUndefined();
  expect(voz.generadas).toBeGreaterThan(0);
}

test("seek_pinta_fotograma: reproducir mueve el tiempo y cambia lo que pinta el iframe (motor real)", async ({ page }) => {
  // Misma condición que los tests reales de T11: el motor necesita ffmpeg para la voz y la preview.
  test.skip(!process.env.E2E_FFMPEG, "Hace falta ffmpeg (FFMPEG_DIR o PATH) para el motor real");
  test.setTimeout(120_000);
  const id = await proyectoDeCocina();
  await generarVoz(id);
  await irAlEditor(page, id);
  await expect(page.getByTestId("preview-marco")).toBeVisible();
  await expect(page.getByTestId("preview-cargando")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("preview-tiempo")).toContainText("0:00 /");
  const antes = await page.getByTestId("preview-marco").screenshot();
  await page.getByTestId("preview-play").click();
  await expect(page.getByTestId("preview-tiempo")).not.toContainText("0:00 /", { timeout: 10_000 });
  await page.getByTestId("preview-play").click(); // ahora pausa
  const despues = await page.getByTestId("preview-marco").screenshot();
  expect(Buffer.compare(antes, despues)).not.toBe(0);
});

test("cambio_se_ve_sin_render: editar un texto recarga la preview con el cambio (CA4, parte 1)", async ({ page }) => {
  test.skip(!process.env.E2E_FFMPEG, "Hace falta ffmpeg (FFMPEG_DIR o PATH) para el motor real");
  test.setTimeout(120_000);
  const id = await proyectoDeCocina();
  await generarVoz(id);
  const posts: number[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith(`/video/proyectos/${id}/preview`)) posts.push(Date.now());
  });
  await irAlEditor(page, id);
  await expect(page.getByTestId("preview-cargando")).toHaveCount(0, { timeout: 30_000 });
  const primera = posts.length;
  await page.locator('[data-testid^="clip-escena-"]').first().click(); // la primera escena es un cartel
  await page.getByTestId("escena-campo-texto").getByRole("textbox").fill("Texto nuevo de prueba");
  await expect.poll(() => posts.length, { timeout: 10_000 }).toBeGreaterThan(primera);
  await expect(page.getByTestId("preview-cargando")).toHaveCount(0, { timeout: 30_000 });
  // El cartel parte el texto en una pieza por palabra (karaoke) y la plantilla lo pone en mayúsculas por CSS.
  await expect(marco(page).locator("body")).toContainText(/texto\s*nuevo\s*de\s*prueba/i);
});

test("voz_desde_el_editor_reabre_la_preview: generar la voz con el editor abierto deja reproducir sin salir", async ({ page }) => {
  test.skip(!process.env.E2E_FFMPEG, "Hace falta ffmpeg (FFMPEG_DIR o PATH) para el motor real");
  test.setTimeout(150_000);
  const id = await proyectoDeCocina();
  await irAlEditor(page, id); // sin voz: el motor todavía no puede montar la preview
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page.getByTestId("preview-play")).toBeDisabled();
  await page.getByTestId("voz-generar").click();
  await page.getByTestId("voz-confirmar-ok").click();
  await expect(page.getByTestId("voz-confirmar")).toHaveCount(0, { timeout: 60_000 });
  // Sin salir del editor: la preview se reabre sola con la voz nueva y reproduce.
  await expect(page.getByTestId("preview-cargando")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("preview-error")).toHaveCount(0);
  await expect(page.getByTestId("preview-play")).toBeEnabled();
  await page.getByTestId("preview-play").click();
  await expect(page.getByTestId("preview-tiempo")).not.toContainText("0:00 /", { timeout: 10_000 });
});
