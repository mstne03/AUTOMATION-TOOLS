/** Preview aislada del editor (T17, I2, I8). Sidecar y motor reales para el seek y el cambio sin
 *  render; composiciones de fixture (servidas con la misma CSP que el backend) para las pruebas de
 *  aislamiento, porque ahí hace falta contenido hostil. */
import { expect, test, type Frame, type Page } from "@playwright/test";
import { simularRutas, type Peticion } from "./sidecar-falso";
import { irAlEditor, limpiarVideo, proyectoDeCocina } from "./video-comun";

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
async function conFixture(page: Page, id: string, html: string, extra: Record<string, unknown> = {}) {
  const llamadas = await simularRutas(page, {
    [`/video/proyectos/${id}/preview`]: (_u: URL, p: Peticion) =>
      p.metodo === "POST"
        ? [200, { url: `${ORIGEN}/p/fixture/index.html`, duracion: 10, avisos: [], fondo: "css", ...extra }]
        : [200, {}],
  });
  await page.route(/127\.0\.0\.1:47810\/p\/fixture\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", headers: { "content-security-policy": CSP, "cache-control": "no-store" }, body: html }),
  );
  return llamadas;
}

const marco = (page: Page): Frame => {
  const f = page.frames().find((x) => x.url().startsWith(`${ORIGEN}/p/`));
  if (!f) throw new Error("el iframe de la preview no está cargado");
  return f;
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
    r.tauri = typeof window.__TAURI__;
    r.origen = location.origin;
    window.__sonda = r;
  `;
  await conFixture(page, id, pagina(CONTROL + sonda));
  await irAlEditor(page, id);
  await expect(page.getByTestId("preview-marco")).toBeVisible();
  await expect.poll(() => marco(page).evaluate(() => (window as unknown as { __sonda?: unknown }).__sonda)).toEqual({
    padre: "bloqueado",
    local: "lanza",
    tauri: "undefined",
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
  const externas: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://127.0.0.1") && !r.url().startsWith("http://localhost") && !r.url().startsWith("data:")) externas.push(r.url());
  });
  await irAlEditor(page, id);
  await expect(page.getByTestId("preview-marco")).toBeVisible();
  await expect
    .poll(() => marco(page).evaluate(() => (window as unknown as { __red: Record<string, string> }).__red))
    .toEqual({ fetch: "bloqueado", ws: "bloqueado", img: "bloqueado" });
  expect(externas.filter((u) => u.includes("evil.example"))).toEqual([]);
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

test("seek_pinta_fotograma: reproducir mueve el tiempo y cambia lo que pinta el iframe (motor real)", async ({ page }) => {
  const id = await proyectoDeCocina();
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
  // Necesita el campo de texto del panel de escena (T18, `escena-campo-texto`): se activa al integrarse.
  test.fixme(true, "depende del panel de escena de T18");
  const id = await proyectoDeCocina();
  const posts: number[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith(`/video/proyectos/${id}/preview`)) posts.push(Date.now());
  });
  await irAlEditor(page, id);
  await expect(page.getByTestId("preview-cargando")).toHaveCount(0, { timeout: 30_000 });
  const primera = posts.length;
  await page.getByTestId("escena-campo-texto").fill("Texto nuevo de prueba");
  await expect.poll(() => posts.length, { timeout: 10_000 }).toBeGreaterThan(primera);
  await expect(page.getByTestId("preview-cargando")).toHaveCount(0, { timeout: 30_000 });
  await expect(marco(page).locator("body")).toContainText("Texto nuevo de prueba");
});
