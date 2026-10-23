/** Overlays (Radix) y paleta Ctrl K (cmdk): teclado, foco y navegación. */
import { expect, test } from "@playwright/test";

const DESTINOS: Array<[string, RegExp]> = [
  ["Chat", /#\/chat$/],
  ["Publicar vídeo", /#\/publicar$/],
  ["Panel de canal", /#\/canal$/],
  ["Conocimiento", /#\/kb$/],
  ["Ajustes", /#\/ajustes$/],
];

test.describe("Paleta Ctrl K", () => {
  test("abre con Ctrl K, filtra, navega con Enter y se cierra", async ({ page }) => {
    await page.goto("/#/kb");
    await expect(page.getByTestId("paleta")).toHaveCount(0);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Paleta de comandos" })).toBeVisible();
    await expect(page.getByTestId("paleta-input")).toBeFocused();
    await page.getByTestId("paleta-input").fill("ajust");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/ajustes$/);
    await expect(page.getByRole("dialog", { name: "Paleta de comandos" })).toHaveCount(0);
  });

  for (const [nombre, url] of DESTINOS) {
    test(`navega a ${nombre}`, async ({ page }) => {
      await page.goto("/#/kb");
      await page.keyboard.press("Control+k");
      await page.getByRole("option", { name: nombre, exact: true }).click();
      await expect(page).toHaveURL(url);
    });
  }

  test("Escape la cierra, Ctrl K alterna y 'Nueva conversación' vuelve al chat", async ({ page }) => {
    await page.goto("/#/ajustes");
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("paleta-input")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("paleta-input")).toHaveCount(0);
    await page.keyboard.press("Control+k");
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("paleta-input")).toHaveCount(0);
    await page.keyboard.press("Control+k");
    await page.getByRole("option", { name: "Nueva conversación" }).click();
    await expect(page).toHaveURL(/#\/chat$/);
  });
});

test.describe("Overlays en el catálogo", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/catalogo");
    await expect(page.getByTestId("catalogo")).toBeVisible();
  });

  test("Dialog: Escape lo cierra y el foco vuelve al botón que lo abrió", async ({ page }) => {
    const abrir = page.getByTestId("catalogo-oscuro").getByRole("button", { name: "Abrir Dialog" });
    await abrir.click();
    const dialogo = page.getByRole("dialog", { name: "Título del diálogo" });
    await expect(dialogo).toBeVisible();
    await expect(dialogo.getByRole("button", { name: "Entendido" })).toBeFocused();
    await page.keyboard.press("Tab"); // el foco no puede salir del diálogo
    await expect(dialogo.getByRole("button", { name: "Entendido" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialogo).toHaveCount(0);
    await expect(abrir).toBeFocused();
  });

  test("ConfirmDialog destructivo: confirmar dispara un toast anunciado como status", async ({ page }) => {
    await page.getByTestId("catalogo-oscuro").getByRole("button", { name: "Abrir ConfirmDialog" }).click();
    const dialogo = page.getByRole("dialog", { name: "¿Borrar la clave de Anthropic?" });
    await dialogo.getByRole("button", { name: "Borrar" }).click();
    await expect(dialogo).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Clave borrada" }).first()).toBeVisible();
  });

  test("DropdownMenu de elección única: teclado, opción marcada y cierre con Escape", async ({ page }) => {
    const panel = page.getByTestId("catalogo-oscuro");
    const boton = panel.getByRole("button", { name: /Modelo: Opus 5.5/ });
    await boton.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitemradio", { name: /Opus 5.5/ })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("button", { name: /Modelo: Sonnet 5.5/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("Popover y Tooltip se abren con el teclado", async ({ page }) => {
    const panel = page.getByTestId("catalogo-oscuro");
    await panel.getByRole("button", { name: "Popover", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Detalles" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Detalles" })).toHaveCount(0);
    await panel.getByRole("button", { name: "Buscar en el catálogo" }).focus();
    await expect(page.getByRole("tooltip").first()).toContainText("Ayuda visual");
  });
});
