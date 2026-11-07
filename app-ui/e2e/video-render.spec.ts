/** Render, exportar y errores del render (Task 20, docs/pantallas.md › Render). El proyecto y el editor
 *  son reales (sidecar con el motor real); el render NO: un render de verdad tarda minutos y necesita
 *  ffmpeg y el navegador del render. `POST …/render`, `GET /jobs` y `…/voz/coste` se simulan SIEMPRE, y
 *  los POST de render se anotan para comprobar que nunca salió uno sin querer. Fuera de Tauri no existe
 *  `exportar_mp4`: el E2E comprueba el aviso, no el diálogo nativo (lo prueba Marc con la app).
 *  La voz real de un proyecto recién creado está pendiente: eso es justo el bloqueo del primer test. */
import { expect, test, type Page } from "@playwright/test";
import { simularRutas, type Peticion } from "./sidecar-falso";
import { irAlEditor, limpiarVideo, proyectoDeCocina } from "./video-comun";

const RESULTADO = { id: "", duracion: 12.5, modo: "compatible", codificador: "h264_mf", avisos: ["Foto pequeña en la escena 2"], reserva: "Rápido falló (sin GPU); se repite en Compatible." };

interface Estado {
  job: Record<string, unknown> | null;
  pendientes: string[];
  renders: unknown[];
}

function jobDe(id: string, extra: Record<string, unknown>) {
  return {
    id: "j-e2e-1",
    kind: "video_render",
    args: { id, titulo: "Tortilla perfecta", modo: "auto" },
    status: "queued",
    progress: 0,
    result: null,
    error: null,
    created_at: "2026-11-07T10:00:00Z",
    updated_at: "2026-11-07T10:00:00Z",
    ...extra,
  };
}

async function preparar(page: Page, id: string, inicial: Partial<Estado> = {}) {
  const est: Estado = { job: null, pendientes: [], renders: [], ...inicial };
  await simularRutas(page, {
    [`/video/proyectos/${id}/voz/coste`]: () => [200, { pendientes: est.pendientes, caracteres: 0, caracteresRefacturados: 0, fallidasFacturadas: [], plan: "p", voz: { id: "v", nombre: "Lucía" } }],
    [`/video/proyectos/${id}/render`]: (_u: URL, p: Peticion) => {
      if (p.metodo !== "POST") return [405, { detail: "x" }];
      est.renders.push(p.cuerpo);
      est.job = jobDe(id, { status: "running", progress: 0.4 });
      return [202, est.job];
    },
    "/jobs": () => [200, est.job ? [est.job] : []],
  });
  await irAlEditor(page, id);
  await expect(page.getByTestId("editor-guardado")).toHaveText("Guardado");
  return est;
}

test.describe("Render", () => {
  let id: string;
  test.beforeEach(async ({ page }) => {
    await limpiarVideo();
    id = await proyectoDeCocina();
    await page.emulateMedia({ colorScheme: "light" });
  });
  test.afterAll(async () => {
    await limpiarVideo();
  });

  const abrir = async (page: Page) => {
    await page.getByTestId("editor-render").click();
    await expect(page.getByTestId("render-dialogo")).toBeVisible();
  };

  test("render_bloqueado_sin_voz: con la voz real pendiente no se puede lanzar", async ({ page }) => {
    // Sin simular el coste: el motor real dice que todas las frases están sin voz.
    const renders: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/render")) renders.push(r.url());
    });
    await irAlEditor(page, id);
    await expect(page.getByTestId("editor-guardado")).toHaveText("Guardado");
    await abrir(page);
    await expect(page.getByTestId("render-bloqueo")).toContainText("por generar en la voz");
    await expect(page.getByTestId("render-bloqueo")).toHaveAttribute("data-motivo", "voz");
    await expect(page.getByTestId("render-lanzar")).toBeDisabled();
    expect(renders).toHaveLength(0);
  });

  test("render_hasta_resultado: lanza con el modo guardado, enseña el progreso y el resultado con la reserva", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("seo-studio.render-modo", "compatible"));
    const est = await preparar(page, id);
    await abrir(page);
    await expect(page.getByTestId("render-lanzar")).toBeEnabled();
    await expect(page.getByTestId("render-bloqueo")).toHaveCount(0);
    await page.getByTestId("render-lanzar").click();
    expect(est.renders).toEqual([{ modo: "compatible" }]);
    await expect(page.getByTestId("render-progreso").getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    await expect(page.getByTestId("render-lanzar")).toHaveCount(0);
    await expect(page.getByTestId("render-resultado")).toHaveCount(0);

    est.job = jobDe(id, { status: "done", progress: 1, result: { ...RESULTADO, id } });
    await expect(page.getByTestId("render-resultado")).toContainText("12,5 s", { timeout: 10_000 });
    await expect(page.getByTestId("render-progreso")).toHaveCount(0);
    const avisos = page.getByTestId("render-avisos");
    await expect(avisos).toContainText("h264_mf");
    await expect(avisos).toContainText("Rápido falló (sin GPU); se repite en Compatible.");
    await expect(avisos).toContainText("Foto pequeña en la escena 2");
    await expect(page.getByTestId("render-error")).toHaveCount(0);
    await expect(page.getByTestId("render-exportar")).toBeVisible();
    expect(est.renders).toHaveLength(1);

    // Fuera de Tauri no hay diálogo de guardar: se explica, sin ruta ni excepción.
    await page.getByTestId("render-exportar").click();
    await expect(page.getByTestId("render-error")).toContainText("aplicación de escritorio");
  });

  test("render_fallido_legible (CA6): el fallo se ve como texto, sin rutas, y se puede reintentar", async ({ page }) => {
    const est = await preparar(page, id);
    await abrir(page);
    await page.getByTestId("render-lanzar").click();
    await expect(page.getByTestId("render-progreso")).toBeVisible();

    est.job = jobDe(id, { status: "failed", progress: 0.4, error: "ffmpeg salió con 1 en C:\\Users\\Marc\\AppData\\Local\\seo-studio\\video\\" + id + "\\_render\\r1 <img src=x onerror=alert(1)>" });
    const error = page.getByTestId("render-error");
    await expect(error).toContainText("ffmpeg salió con 1", { timeout: 10_000 });
    await expect(error).toContainText("<img src=x onerror=alert(1)>");
    await expect(error).not.toContainText("AppData");
    await expect(error).not.toContainText("_render");
    await expect(error).toHaveAttribute("role", "alert");
    await expect(error.locator("img, script")).toHaveCount(0);
    await expect(page.getByTestId("render-resultado")).toHaveCount(0);
    await expect(page.getByTestId("render-lanzar")).toHaveText("Reintentar");
    await expect(page.getByTestId("render-lanzar")).toBeEnabled();

    // Reintentar vuelve a lanzar y quita el error anterior.
    await page.getByTestId("render-lanzar").click();
    await expect(page.getByTestId("render-progreso")).toBeVisible();
    await expect(page.getByTestId("render-error")).toHaveCount(0);
    expect(est.renders).toHaveLength(2);
  });

  test("cerrar y reabrir el diálogo con el render en curso retoma el progreso", async ({ page }) => {
    const est = await preparar(page, id);
    await abrir(page);
    await page.getByTestId("render-lanzar").click();
    await expect(page.getByTestId("render-progreso")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("render-dialogo")).toHaveCount(0);
    await abrir(page);
    await expect(page.getByTestId("render-progreso").getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    await expect(page.getByTestId("render-lanzar")).toHaveCount(0);
    expect(est.renders).toHaveLength(1);
  });

  test("un 409 con código sin_voz del servidor es un bloqueo, no un error", async ({ page }) => {
    await preparar(page, id);
    // Registrada después, tiene prioridad sobre la ruta de render simulada.
    await page.route(new RegExp(`127\\.0\\.0\\.1:\\d+/video/proyectos/${id}/render`), (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 409, headers: { "access-control-allow-origin": "http://localhost:1420" }, contentType: "application/json", body: JSON.stringify({ detail: { mensaje: "Faltan frases por generar.", codigo: "sin_voz" } }) })
        : route.fallback(),
    );
    await abrir(page);
    await page.getByTestId("render-lanzar").click();
    await expect(page.getByTestId("render-bloqueo")).toContainText("Faltan frases por generar.");
    await expect(page.getByTestId("render-error")).toHaveCount(0);
  });
});
