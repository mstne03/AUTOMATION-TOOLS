import { expect, test } from "@playwright/test";
import { settings, youtube } from "./api";

test.describe("Publicar vídeo", () => {
  test("la ruta debe estar dentro de una carpeta permitida; botones bloqueados hasta entonces", async ({ page }) => {
    const s = await settings();
    const dir = s.allowed_dirs[0].path;
    await page.goto("/#/publicar");
    await expect(page.getByTestId("publicar-fichero")).toBeVisible();
    await expect(page.getByTestId("publicar-transcribir")).toBeDisabled();
    await expect(page.getByTestId("borrador-generar")).toBeDisabled();
    await expect(page.getByTestId("publicar-subir")).toBeDisabled();
    await expect(page.getByTestId("publicar-subir-motivo")).toContainText("Falta elegir un vídeo");

    // Fuera de Tauri no hay diálogo nativo: el botón existe pero no cambia la ruta.
    await expect(page.getByTestId("publicar-elegir")).toBeEnabled();
    await page.getByTestId("publicar-elegir").click();
    await expect(page.getByTestId("publicar-path")).toHaveValue("");
    await expect(page.getByTestId("publicar-elegir-error")).toHaveCount(0);

    await page.getByTestId("publicar-path").fill("C:\\otra\\carpeta\\video.mp4");
    await expect(page.getByTestId("publicar-path-error")).toContainText(dir);
    await expect(page.getByTestId("publicar-transcribir")).toBeDisabled();

    await page.getByTestId("publicar-path").fill(`${dir}\\demo.mp4`);
    await expect(page.getByTestId("publicar-path-error")).toHaveCount(0);
    await expect(page.getByTestId("publicar-transcribir")).toBeEnabled();
    await expect(page.getByTestId("borrador-generar")).toBeEnabled();
    await expect(page.getByTestId("publicar-subir")).toBeDisabled(); // falta el título
    await expect(page.getByTestId("publicar-subir-motivo")).toHaveText("Falta el título del borrador.");
    await page.getByTestId("borrador-title").fill("Título E2E");
    await expect(page.getByTestId("publicar-subir")).toBeEnabled();
    await expect(page.getByTestId("publicar-subir-motivo")).toHaveCount(0);
    await expect(page.getByTestId("borrador-privacy").getByRole("radio", { name: "Privado" })).toBeChecked();
  });

  test("subir: la petición llega al agente y la propuesta aparece inline sin ejecutar nada", async ({ page }) => {
    const s = await settings();
    await page.goto("/#/publicar");
    await page.getByTestId("publicar-path").fill(`${s.allowed_dirs[0].path}\\demo.mp4`);
    await page.getByTestId("borrador-title").fill("E2E-RECHAZO título");
    await page.getByTestId("publicar-subir").click();
    const card = page.getByTestId("publicar-aprobacion").getByTestId("approval-card");
    await expect(card).toBeVisible();
    await card.getByTestId("approval-rechazar").click();
    await expect(page.getByTestId("publicar-turnos").getByTestId("tool-estado")).toHaveText("rechazada");
  });
});

test.describe("Panel de canal", () => {
  test("estado y cuota del sidecar; el análisis se lanza en el chat", async ({ page }) => {
    const yt = await youtube();
    await page.goto("/#/canal");
    const estado = page.getByTestId("canal-estado");
    await expect(estado).toContainText(yt.auth.profile);
    await expect(estado).toContainText(yt.auth.authenticated ? "Autorizado" : "Sin autorizar");
    const miles = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    for (const [b, v] of Object.entries(yt.quota.buckets)) {
      await expect(page.getByTestId("canal-cuota").getByTestId(`cuota-${b}`)).toContainText(`${miles(v.used)} de ${miles(v.limit)}`);
    }
    const boton = page.getByTestId("canal-pregunta");
    if (!yt.auth.authenticated) {
      await expect(boton).toBeDisabled();
      return;
    }
    await boton.click();
    await expect(page).toHaveURL(/#\/chat$/);
    await expect(page.getByTestId("msg-user")).toContainText("Analiza mi canal");
  });
});
