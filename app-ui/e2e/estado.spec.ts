/** UI-01 / UI-12: el estado vive por encima del router. Cambiar de pantalla no pierde la
 *  conversación (ni una aprobación pendiente) ni el progreso de un job. */
import { expect, test, type Page } from "@playwright/test";
import { settings } from "./api";

test("una aprobación pendiente sobrevive a ir a Ajustes y volver, y se resuelve", async ({ page }) => {
  await page.goto("/#/chat");
  await page.getByTestId("chat-input").fill("E2E-BORRAR");
  await page.getByTestId("chat-enviar").click();
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible();

  await page.getByTestId("nav-ajustes").click();
  await expect(page).toHaveURL(/#\/ajustes$/);
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  await page.getByTestId("nav-chat").click();

  await expect(page.getByTestId("msg-user")).toHaveText("E2E-BORRAR");
  await expect(card).toBeVisible();
  await card.getByTestId("approval-confirm").fill("vid9");
  await card.getByTestId("approval-aprobar").click();
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  await expect(page.getByTestId("tool-estado")).toHaveText(/aprobada|hecho|error/);
  await expect(page.getByTestId("chat-enviar")).toBeVisible({ timeout: 30_000 });
});

/** Sidecar simulado solo para /jobs: un job de transcripción cuyo progreso controla el test. */
async function simularJobs(page: Page) {
  const estado = { status: "running", progress: 0.2 };
  const job = () => ({
    id: "j-e2e",
    kind: "transcribe",
    args: {},
    status: estado.status,
    progress: estado.progress,
    result: estado.status === "done" ? { full_text: "hola desde el job", segments: [] } : null,
    error: null,
    created_at: "2026-10-23T10:00:00Z",
    updated_at: new Date().toISOString(),
  });
  const cors = {
    "access-control-allow-origin": "http://localhost:1420",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
  await page.route("**/jobs", async (route) => {
    const m = route.request().method();
    if (m === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const cuerpo = m === "POST" ? job() : [job()];
    return route.fulfill({ status: m === "POST" ? 201 : 200, headers: cors, contentType: "application/json", body: JSON.stringify(cuerpo) });
  });
  return estado;
}

test("el progreso de una transcripción se conserva al cambiar de pantalla", async ({ page }) => {
  const s = await settings();
  const job = await simularJobs(page);
  await page.goto("/#/publicar");
  await page.getByTestId("publicar-path").fill(`${s.allowed_dirs[0].path}\\demo.mp4`);
  await page.getByTestId("publicar-transcribir").click();
  await expect(page.getByTestId("publicar-progreso")).toContainText("20 %");

  await page.getByTestId("nav-kb").click();
  job.progress = 0.6; // el sondeo del store sigue corriendo fuera de la pantalla
  await page.waitForTimeout(2500);
  await page.getByTestId("nav-publicar").click();
  await expect(page.getByTestId("publicar-path")).toHaveValue(`${s.allowed_dirs[0].path}\\demo.mp4`);
  await expect(page.getByTestId("publicar-progreso")).toContainText("60 %");

  job.status = "done";
  job.progress = 1;
  await expect(page.getByTestId("publicar-transcripcion")).toHaveValue("hola desde el job");
});

test("la transcripción que termina con otra pantalla abierta queda guardada", async ({ page }) => {
  const s = await settings();
  const job = await simularJobs(page);
  await page.goto("/#/publicar");
  await page.getByTestId("publicar-path").fill(`${s.allowed_dirs[0].path}\\demo.mp4`);
  await page.getByTestId("publicar-transcribir").click();
  await expect(page.getByTestId("publicar-progreso")).toBeVisible();
  await page.getByTestId("nav-ajustes").click();
  job.status = "done";
  job.progress = 1;
  await page.waitForTimeout(2500);
  await page.getByTestId("nav-publicar").click();
  await expect(page.getByTestId("publicar-transcripcion")).toHaveValue("hola desde el job");
});
