/** Chat rediseñado (artboard "Chat (oscuro)"): Markdown completo, pasos agrupados, aprobación v2,
 *  cabecera y compositor. Sidecar real con Anthropic falso. */
import { expect, test } from "@playwright/test";

test.describe("Chat rediseñado", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/chat");
    await expect(page.getByTestId("chat-vacio")).toBeVisible();
  });

  test("Markdown: cabecera, tabla en caja, cita, código, lista y fuentes; el HTML crudo sale como texto", async ({ page }) => {
    await page.getByTestId("chat-input").fill("E2E-MARKDOWN");
    await page.getByTestId("chat-enviar").click();
    const texto = page.getByTestId("bloque-texto").first();
    await expect(texto.locator("h3")).toHaveText("Recomendaciones");
    await expect(texto.locator("strong")).toHaveText("negrita");
    await expect(texto.locator("em")).toHaveText("cursiva");
    await expect(texto.locator("p code")).toHaveText("código");
    const tabla = texto.getByTestId("md-tabla");
    await expect(tabla.locator("th")).toHaveText(["Acción", "Impacto"]);
    await expect(tabla.locator("tbody tr")).toHaveCount(2);
    await expect(tabla.locator("tbody tr").first().locator("td").nth(1)).toHaveCSS("text-align", "right");
    await expect(tabla).toHaveCSS("overflow-x", "auto");
    await expect(texto.locator("blockquote")).toHaveText("Una cita del informe.");
    await expect(texto.locator("ol li")).toHaveCount(2);
    await expect(texto.locator("pre code")).toContainText("const titulo");
    // fuentes: la URL pasa a ser un chip "n · dominio ↗" y el enlace con texto conserva su texto
    await expect(texto.getByRole("link", { name: "1 · support.google.com ↗" })).toHaveAttribute("href", "https://support.google.com/youtube/answer/1");
    await expect(texto.getByRole("link", { name: "guía" })).toHaveAttribute("href", "https://www.tiktok.com/creators");
    // nada de HTML crudo ni cabeceras en crudo
    await expect(texto.locator("img")).toHaveCount(0);
    await expect(texto).toContainText("<img src=x onerror=alert(1)>");
    await expect(texto).not.toContainText("##");
    await expect(texto).not.toContainText("| ---");
  });

  test("aprobación de subida v2: título legible, rejilla, etiquetas, descripción plegable, detalles técnicos y foco", async ({ page }) => {
    await page.getByTestId("chat-input").fill("E2E-SUBIR");
    await page.getByTestId("chat-enviar").click();
    const card = page.getByTestId("approval-card");
    await expect(card).toBeVisible();
    await expect(card).toBeFocused(); // una aprobación pendiente lleva el foco
    await expect(card.locator("header strong")).toHaveText("Subir vídeo a YouTube");
    await expect(card.getByTestId("approval-risk")).toHaveText("Escritura");
    const args = card.getByTestId("approval-args");
    await expect(args).toContainText("Fichero");
    await expect(args).toContainText("Título");
    await expect(args).toContainText("Privado"); // privacy_status traducido
    await expect(args).not.toContainText("privacy_status");
    await expect(args.locator("tr").filter({ hasText: "Etiquetas" }).locator("span span")).toHaveText(["cs2", "skins", "cs finance"]);
    // la descripción larga se corta y se despliega
    await expect(args).toContainText("Ver completa");
    await args.getByRole("button", { name: "Ver completa" }).click();
    await expect(args.getByRole("button", { name: "Ocultar" })).toBeVisible();
    // el JSON no se duplica: queda tras "Ver detalles técnicos"
    await expect(card.getByTestId("approval-json")).toHaveCount(0);
    await card.getByTestId("approval-tecnico").click();
    await expect(card.getByTestId("approval-json")).toContainText("youtube_upload_video");
    await expect(card.getByTestId("approval-aprobar")).toHaveText("Aprobar y subir");
    await card.getByTestId("approval-rechazar").click();
    await expect(page.getByTestId("approval-card")).toHaveCount(0);
  });

  test("pasos agrupados: resumen legible, riesgo en español y detalle técnico plegado", async ({ page }) => {
    await page.getByTestId("chat-input").fill("E2E-RECHAZO");
    await page.getByTestId("chat-enviar").click();
    const grupo = page.getByTestId("pasos");
    await expect(grupo.locator("summary").first()).toContainText("1 paso · Actualizar un vídeo");
    const paso = page.getByTestId("bloque-tool");
    await expect(paso.locator("summary")).toContainText("Actualizar un vídeo");
    await expect(paso.locator("summary")).toContainText("Escritura");
    await expect(paso.locator("summary")).not.toContainText("youtube_update_video"); // el nombre técnico va en el detalle
    await page.getByTestId("approval-rechazar").click();
    await expect(page.getByTestId("tool-estado")).toHaveText("rechazada");
    await expect(page.getByTestId("pasos")).not.toHaveAttribute("open", ""); // al terminar se pliega
  });

  test("cabecera: título de la conversación, selector de modelo y 'Nueva'", async ({ page }) => {
    const header = page.getByTestId("chat-header");
    await expect(header.getByRole("heading", { level: 1 })).toHaveText("Nueva conversación");
    await page.getByTestId("chat-input").fill("Hola E2E-TEXTO para el título");
    await page.getByTestId("chat-enviar").click();
    await expect(header.getByRole("heading", { level: 1 })).toHaveText("Hola E2E-TEXTO para el título");
    await expect(page.getByTestId("chat-enviar")).toBeVisible();

    await page.getByTestId("chat-modelo").click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitemradio")).toHaveCount(2);
    await expect(menu.getByRole("menuitemradio", { name: /Opus 5.5/ })).toContainText("4 $ / 20 $ por Mtok");
    await expect(menu.getByRole("menuitemradio", { name: /Sonnet 5.5/ })).toContainText("2 $ / 10 $ por Mtok");
    await page.keyboard.press("Escape");

    await page.getByTestId("chat-nueva").click();
    await expect(page.getByTestId("chat-vacio")).toBeVisible();
    await expect(header.getByRole("heading", { level: 1 })).toHaveText("Nueva conversación");
  });

  test("compositor: crece con el texto, 'Usar KB' es un interruptor y Enviar/Cancelar son botones de icono", async ({ page }) => {
    const campo = page.getByTestId("chat-input");
    const alto0 = (await campo.boundingBox())!.height;
    await campo.fill("l1\nl2\nl3\nl4");
    expect((await campo.boundingBox())!.height).toBeGreaterThan(alto0);
    await campo.fill("l1\n".repeat(30));
    expect((await campo.boundingBox())!.height).toBeLessThanOrEqual(170); // tope: luego hace scroll
    await campo.fill("");

    const kb = page.getByTestId("chat-usar-kb");
    await expect(kb).toHaveAttribute("role", "switch");
    await expect(kb).toHaveAttribute("aria-checked", "true");
    await expect(kb).toContainText("sí");
    await kb.click();
    await expect(kb).toHaveAttribute("aria-checked", "false");
    await expect(kb).toContainText("no");

    await expect(page.getByTestId("chat-enviar")).toHaveAttribute("aria-label", "Enviar");
    await page.getByTestId("chat-adjuntar").click(); // fuera de Tauri: avisa en vez de fallar
    await expect(page.getByRole("status").filter({ hasText: "aplicación de escritorio" }).first()).toBeVisible();
    await campo.fill("E2E-RECHAZO");
    await page.getByTestId("chat-enviar").click();
    await expect(page.getByTestId("chat-cancelar")).toHaveAttribute("aria-label", "Cancelar");
    await page.getByTestId("approval-rechazar").click();
  });
});
