import { expect, test } from "@playwright/test";
import { settings } from "./api";

const ENLACES = ["chat", "publicar", "canal", "kb", "ajustes", "onboarding"];

test("barra lateral: título, seis enlaces en orden y activo con aria-current", async ({ page }) => {
  await page.goto("/#/kb");
  const nav = page.getByTestId("nav");
  await expect(nav.locator("h2")).toHaveText("SEO Studio");
  const ids = await nav.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("data-testid")));
  expect(ids).toEqual(ENLACES.map((e) => `nav-${e}`));
  await expect(page.getByTestId("nav-kb")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("nav-chat")).not.toHaveAttribute("aria-current", "page");
  const ancho = await nav.evaluate((n) => n.getBoundingClientRect().width);
  expect(Math.round(ancho)).toBe(220);
});

test("ruta inicial según la configuración del sidecar", async ({ page }) => {
  const s = await settings();
  await page.goto("/");
  const esperado = s.has_anthropic_key && s.has_client_secret ? "/chat" : "/onboarding";
  await expect(page).toHaveURL(new RegExp(`#${esperado}$`));
});

test("sin sidecar accesible se muestra el estado de error", async ({ page }) => {
  // Bloqueamos el sidecar: la UI debe quedarse en un error de carga, no en blanco.
  await page.route("**/settings", (r) => r.abort());
  await page.goto("/#/ajustes");
  await expect(page.locator("main")).toContainText("Error:");
});
