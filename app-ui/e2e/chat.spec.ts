/** Chat contra el sidecar real con un Anthropic falso (e2e/anthropic-mock.ts): el gate de
 *  aprobación, el historial y el stream SSE son los de verdad. */
import { expect, test } from "@playwright/test";

test.describe("Chat", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/chat");
    await expect(page.getByTestId("chat-vacio")).toHaveText("Pregunta al agente o pídele que publique un vídeo.");
  });

  test("texto: mensaje del usuario a la derecha, Markdown del modelo y coste tras done", async ({ page }) => {
    await expect(page.getByTestId("chat-enviar")).toBeDisabled();
    await expect(page.getByTestId("chat-coste")).toHaveCount(0);
    await page.getByTestId("chat-input").fill("Hola E2E-TEXTO");
    await page.getByTestId("chat-input").press("Enter");
    const user = page.getByTestId("msg-user");
    await expect(user).toHaveText("Hola E2E-TEXTO");
    const assistant = page.getByTestId("msg-assistant");
    await expect(assistant.getByTestId("bloque-texto").locator("strong")).toHaveText("Marc");
    await expect(assistant.locator("li")).toHaveCount(2);
    await expect(page.getByTestId("chat-coste")).toContainText("13.861 tokens en caché");
    await expect(page.getByTestId("chat-enviar")).toBeVisible();
    await expect(page.getByTestId("chat-vacio")).toHaveCount(0);
    const [ux, ax] = await Promise.all([user.boundingBox(), assistant.boundingBox()]);
    expect(ux!.x).toBeGreaterThan(ax!.x);
  });

  test("Shift+Enter inserta salto de línea sin enviar", async ({ page }) => {
    await page.getByTestId("chat-input").fill("línea 1");
    await page.getByTestId("chat-input").press("Shift+Enter");
    await page.getByTestId("chat-input").type("línea 2");
    await expect(page.getByTestId("chat-input")).toHaveValue("línea 1\nlínea 2");
    await expect(page.getByTestId("msg-user")).toHaveCount(0);
  });

  test("propuesta de escritura: tarjeta inline, rechazo sin error y turno cerrado", async ({ page }) => {
    await page.getByTestId("chat-input").fill("E2E-RECHAZO");
    await page.getByTestId("chat-enviar").click();
    const card = page.getByTestId("approval-card");
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-risk", "write");
    await expect(card.getByTestId("approval-risk")).toHaveText("Escritura");
    await expect(card.locator("header strong")).toHaveText("Actualizar un vídeo");
    await expect(card.getByTestId("approval-args").locator("tr")).toHaveCount(2);
    await expect(card.getByTestId("approval-args")).toContainText("ID del vídeo");
    await expect(card.getByTestId("approval-confirm")).toHaveCount(0);
    await expect(page.getByTestId("tool-estado")).toHaveText("esperando aprobación");
    await expect(page.getByTestId("chat-cancelar")).toBeVisible();
    await expect(page.getByTestId("chat-input")).toBeDisabled();
    await expect(page.getByTestId("bloque-tool")).toHaveAttribute("data-tool", "youtube_update_video");

    await card.getByTestId("approval-rechazar").click();
    await expect(page.getByTestId("approval-card")).toHaveCount(0);
    await expect(page.getByTestId("tool-estado")).toHaveText("rechazada");
    await expect(page.getByTestId("turno-error")).toHaveCount(0);
    await expect(page.getByTestId("tool-resultado")).toContainText("ha rechazado");
    await expect(page.getByTestId("bloque-texto").last()).toHaveText("Vale, no lo hago.");
    await expect(page.getByTestId("chat-enviar")).toBeVisible();
  });

  test("propuesta destructiva: Aprobar bloqueado hasta escribir el video_id exacto", async ({ page }) => {
    await page.getByTestId("chat-input").fill("E2E-BORRAR");
    await page.getByTestId("chat-enviar").click();
    const card = page.getByTestId("approval-card");
    await expect(card).toHaveAttribute("data-risk", "destructive");
    await expect(card.getByTestId("approval-risk")).toHaveText("Destructiva");
    await expect(card.getByTestId("approval-quota")).toContainText("50 unidades de cuota");
    const confirm = card.getByTestId("approval-confirm");
    await expect(confirm).toHaveAttribute("placeholder", "Escribe el video_id para confirmar");
    await expect(card.getByTestId("approval-aprobar")).toBeDisabled();
    await expect(card.getByTestId("approval-video-id")).toHaveCSS("font-family", /mono|Consolas/i);
    await confirm.fill("vid");
    await expect(card.getByTestId("approval-aprobar")).toBeDisabled();
    await expect(card.getByTestId("approval-confirm-estado")).toHaveText("Falta 1 carácter");
    await confirm.fill("xyz");
    await expect(card.getByTestId("approval-confirm-estado")).toHaveText("El ID no coincide");
    await confirm.fill("vid9");
    await expect(card.getByTestId("approval-confirm-estado")).toHaveText("El ID coincide");
    await expect(card.getByTestId("approval-aprobar")).toBeEnabled();
    // Aprobamos: sin OAuth en el entorno de pruebas la tool falla, y eso SÍ es un error de tool.
    await card.getByTestId("approval-aprobar").click();
    await expect(page.getByTestId("approval-card")).toHaveCount(0);
    await expect(page.getByTestId("tool-estado")).toHaveText(/aprobada|hecho|error/);
    await expect(page.getByTestId("chat-enviar")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("turno-error")).toHaveCount(0);
  });

  test("error del sidecar (409 sin clave) se muestra como error del turno con enlace a Ajustes", async ({ page }) => {
    await page.route("**/chat", (r) =>
      r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: "Falta la clave de Anthropic (PUT /settings)." }) }),
    );
    await page.getByTestId("chat-input").fill("hola");
    await page.getByTestId("chat-enviar").click();
    await expect(page.getByTestId("turno-error")).toContainText("Falta la clave de Anthropic");
    await expect(page.getByTestId("chat-ir-ajustes")).toHaveAttribute("href", "#/ajustes");
  });
});
