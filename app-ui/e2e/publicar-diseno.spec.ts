/** Publicar rediseñado (artboard "Publicar vídeo (oscuro)"): asistente, contadores, programación,
 *  comprobaciones y aprobación en diálogo con comparación frente al borrador. */
import { expect, test, type Page } from "@playwright/test";
import { settings } from "./api";

const TITULO = "CS Finance: controla tu inventario de skins en 60 segundos";
const DESCRIPCION = "Te enseño cómo seguir el valor de tus skins de CS2 con CS Finance. ".repeat(4);

async function conRuta(page: Page, nombre = "demo.mp4") {
  const s = await settings();
  await page.goto("/#/publicar");
  await page.getByTestId("publicar-path").fill(`${s.allowed_dirs[0].path}\\${nombre}`);
  return s;
}

test.describe("Publicar rediseñado", () => {
  test("asistente: el paso actual se deriva de los datos y los completados son navegables", async ({ page }) => {
    await page.goto("/#/publicar");
    const paso = (n: number) => page.getByTestId(`publicar-paso-${n}`);
    await expect(paso(1)).toHaveAttribute("aria-current", "step");
    await expect(paso(1)).toHaveAttribute("data-estado", "actual");
    await expect(paso(2)).toHaveAttribute("data-estado", "pendiente");
    const s = await settings();
    await page.getByTestId("publicar-path").fill(`${s.allowed_dirs[0].path}\\demo.mp4`);
    await expect(paso(1)).toHaveAttribute("data-estado", "hecho");
    await expect(paso(2)).toHaveAttribute("aria-current", "step"); // transcripción: opcional, pero es el siguiente
    await page.getByTestId("borrador-title").fill("Algo");
    await expect(paso(3)).toHaveAttribute("data-estado", "hecho");
    await expect(paso(4)).toHaveAttribute("aria-current", "step");
    // un paso completado devuelve el foco a su campo
    await paso(3).getByRole("button").click();
    await expect(page.getByTestId("borrador-title")).toBeFocused();
    await paso(1).getByRole("button").click();
    await expect(page.getByTestId("publicar-path")).toBeFocused();
  });

  test("contadores: título en caracteres, descripción en bytes UTF-8 y etiquetas con comas", async ({ page }) => {
    await page.goto("/#/publicar");
    const contador = (etiqueta: string) => page.getByText(etiqueta, { exact: true }).locator("xpath=following-sibling::span[@data-testid='field-contador']");
    await expect(contador("Título")).toHaveText("0 / 100");
    await page.getByTestId("borrador-title").fill("Cómo");
    await expect(contador("Título")).toHaveText("4 / 100");
    await page.getByTestId("borrador-description").fill("áé");
    await expect(contador("Descripción")).toHaveText("4 / 5000"); // 2 caracteres, 4 bytes
    const tags = page.getByTestId("borrador-tags");
    await tags.fill("cs2");
    await tags.press("Enter");
    await tags.fill("cs finance");
    await tags.press("Enter");
    await expect(contador("Etiquetas")).toHaveText("16 / 500"); // 3 + 1 coma + 10 + 2 comillas
    await expect(page.getByTestId("taginput").getByRole("listitem")).toHaveText(["cs2×", "cs finance×"].map((t) => t.replace("×", "")));
  });

  test("validación: < y > o pasarse del límite bloquean la subida con el motivo", async ({ page }) => {
    await conRuta(page);
    await page.getByTestId("borrador-title").fill("Título <malo>");
    await expect(page.getByTestId("publicar-subir")).toBeDisabled();
    await expect(page.getByTestId("publicar-subir-motivo")).toHaveText("El título no puede llevar < ni >.");
    await page.getByTestId("borrador-title").fill("x".repeat(101));
    await expect(page.getByTestId("publicar-subir-motivo")).toContainText("pasa de 100 caracteres");
    await page.getByTestId("borrador-title").fill("Bien");
    await expect(page.getByTestId("publicar-subir")).toBeEnabled();
    await page.getByTestId("borrador-description").fill("Mira [ENLACE A CSFINANCE.APP]");
    await expect(page.getByTestId("publicar-subir")).toBeEnabled(); // el marcador sin rellenar solo avisa
    await expect(page.getByTestId("publicar-comprobaciones").locator("li[data-nivel=aviso]")).toContainText("marcador sin rellenar");
  });

  test("programar fija 'Privado' y bloquea las otras visibilidades; una fecha pasada no se admite", async ({ page }) => {
    await conRuta(page);
    await page.getByTestId("borrador-title").fill("Programado");
    const vis = page.getByTestId("borrador-privacy");
    await vis.getByRole("radio", { name: "Público" }).click();
    await expect(vis.getByRole("radio", { name: "Público" })).toBeChecked();
    const futura = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    await page.getByTestId("borrador-publishAt").fill(local(futura));
    await expect(vis.getByRole("radio", { name: "Privado" })).toBeChecked();
    await expect(vis.getByRole("radio", { name: "Público" })).toBeDisabled();
    await expect(vis.getByRole("radio", { name: "Oculto" })).toBeDisabled();
    await expect(page.getByText(/Se sube privado y YouTube lo publica a esa hora/)).toBeVisible();
    await expect(page.getByTestId("publicar-subir")).toBeEnabled();
    await page.getByTestId("borrador-publishAt").fill(local(new Date(Date.now() - 24 * 3600 * 1000)));
    await expect(page.getByTestId("publicar-subir")).toBeDisabled();
    await expect(page.getByTestId("publicar-subir-motivo")).toHaveText("La fecha programada ya ha pasado.");
    await page.getByTestId("borrador-publishAt").fill("");
    await expect(vis.getByRole("radio", { name: "Público" })).toBeEnabled();
  });

  test("vista previa y comprobaciones se actualizan en vivo", async ({ page }) => {
    await conRuta(page);
    await expect(page.getByTestId("publicar-previa-titulo")).toHaveText("Sin título");
    await page.getByTestId("borrador-title").fill("Mi título");
    await expect(page.getByTestId("publicar-previa-titulo")).toHaveText("Mi título");
    const lista = page.getByTestId("publicar-comprobaciones");
    await expect(lista).toContainText("Título dentro del límite y sin < ni >");
    await expect(lista).toContainText("Fichero dentro de una carpeta permitida");
    await expect(lista).toContainText("Cuota:");
  });

  test("la aprobación se abre en un diálogo y, si coincide con el borrador, lo dice", async ({ page }) => {
    await conRuta(page, "demo E2E-FIEL.mp4");
    await page.getByTestId("borrador-title").fill(TITULO);
    await page.getByTestId("borrador-description").fill(DESCRIPCION.trim());
    const tags = page.getByTestId("borrador-tags");
    for (const t of ["cs2", "skins", "cs finance"]) {
      await tags.fill(t);
      await tags.press("Enter");
    }
    await page.getByTestId("publicar-subir").click();
    const dialogo = page.getByRole("dialog", { name: "Revisar y subir" });
    await expect(dialogo).toBeVisible();
    await expect(dialogo.getByTestId("approval-card")).toBeVisible();
    await expect(dialogo.getByTestId("publicar-coincide")).toHaveText("Coincide con tu borrador");
    await expect(dialogo.getByTestId("approval-aprobar")).toBeEnabled();
    await page.keyboard.press("Escape"); // una propuesta pendiente no se descarta sin decidir
    await expect(dialogo).toBeVisible();
    await dialogo.getByTestId("approval-rechazar").click();
    await expect(dialogo).toHaveCount(0);
    await expect(page.getByTestId("publicar-turnos").getByTestId("tool-estado")).toHaveText("rechazada");
  });

  test("si el agente propone subir otro fichero, no dice que coincide y 'Aprobar' queda bloqueado", async ({ page }) => {
    const s = await conRuta(page, "demo E2E-SUBIR.mp4");
    await page.getByTestId("borrador-title").fill(TITULO);
    await page.getByTestId("borrador-description").fill(DESCRIPCION.trim());
    const tags = page.getByTestId("borrador-tags");
    for (const t of ["cs2", "skins", "cs finance"]) {
      await tags.fill(t);
      await tags.press("Enter");
    }
    await page.getByTestId("publicar-subir").click();
    const dialogo = page.getByRole("dialog", { name: "Revisar y subir" });
    const dif = dialogo.getByTestId("publicar-diferencias");
    await expect(dif).toContainText("Fichero");
    await expect(dif).toContainText(`${s.allowed_dirs[0].path}\\demo E2E-SUBIR.mp4`);
    await expect(dif).toContainText("demo cs finance"); // lo que propone el agente
    await expect(dialogo.getByTestId("publicar-coincide")).toHaveCount(0);
    await expect(dialogo.getByTestId("approval-aprobar")).toBeDisabled();
    await dialogo.getByTestId("approval-rechazar").click();
    await expect(dialogo).toHaveCount(0);
  });

  test("si el agente cambia algo, se marcan las diferencias y 'Aprobar' queda bloqueado hasta aceptarlas", async ({ page }) => {
    await conRuta(page, "demo E2E-FIEL.mp4");
    await page.getByTestId("borrador-title").fill("Mi título propio");
    await page.getByTestId("publicar-subir").click();
    const dialogo = page.getByRole("dialog", { name: "Revisar y subir" });
    const dif = dialogo.getByTestId("publicar-diferencias");
    await expect(dif).toContainText("El agente propone algo distinto de tu borrador");
    await expect(dif).toContainText("Título");
    await expect(dif).toContainText("Mi título propio");
    await expect(dif).toContainText(TITULO);
    await expect(dialogo.getByTestId("approval-aprobar")).toBeDisabled();
    await dialogo.getByTestId("publicar-acepto").check();
    await expect(dialogo.getByTestId("approval-aprobar")).toBeEnabled();
    await dialogo.getByTestId("approval-rechazar").click();
    await expect(dialogo).toHaveCount(0);
  });

  test("Descartar pide confirmación y deja la pantalla vacía", async ({ page }) => {
    await conRuta(page);
    await page.getByTestId("borrador-title").fill("Para descartar");
    await page.getByRole("button", { name: "Descartar" }).click();
    const dialogo = page.getByRole("dialog", { name: "¿Descartar el borrador?" });
    await dialogo.getByRole("button", { name: "Cancelar" }).click();
    await expect(page.getByTestId("borrador-title")).toHaveValue("Para descartar");
    await page.getByRole("button", { name: "Descartar" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Descartar" }).click();
    await expect(page.getByTestId("borrador-title")).toHaveValue("");
    await expect(page.getByTestId("publicar-path")).toHaveValue("");
  });
});

test.describe("Publicar: aprobación huérfana", () => {
  test("si el stream se corta con la subida pendiente, el diálogo no se queda abierto sin salida", async ({ page }) => {
    const ruta = "C:/Videos/demo.mp4";
    const args = { file_path: ruta, title: "Corte", description: "", tags: [], privacy_status: "private", publish_at: null };
    const eventos = [
      { type: "tool_use", id: "tu_corte", name: "youtube_upload_video", input: args },
      { type: "approval_required", approval: { id: "ap_corte", tool: "youtube_upload_video", args, risk: "write", quota: { bucket: "video_insert", cost: 1 }, status: "pending", requires_confirm_id: false } },
    ]; // y el sidecar desaparece: sin done ni error
    await page.route(/127\.0\.0\.1:\d+\/chat$/, (route) =>
      route.request().method() === "OPTIONS"
        ? route.fulfill({ status: 204, headers: { "access-control-allow-origin": "http://localhost:1420", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "POST, OPTIONS" } })
        : route.fulfill({
            status: 200,
            headers: { "access-control-allow-origin": "http://localhost:1420", "content-type": "text/event-stream" },
            body: eventos.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
          }),
    );
    await conRuta(page);
    await page.getByTestId("borrador-title").fill("Corte");
    await page.getByTestId("publicar-subir").click();
    await expect(page.getByTestId("publicar-turnos").getByTestId("turno-error")).toContainText("se cortó");
    await expect(page.getByTestId("publicar-turnos").getByTestId("tool-estado")).toHaveText("cancelada");
    await expect(page.getByRole("dialog", { name: "Revisar y subir" })).toHaveCount(0);
    await expect(page.getByTestId("publicar-subir")).toBeEnabled(); // se puede volver a intentar
  });
});
