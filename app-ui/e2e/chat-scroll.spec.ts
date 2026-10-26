/** Scroll del chat mientras se genera la respuesta (SEO-105). Sidecar real; el Anthropic falso emite
 *  la respuesta «E2E-LENTO» en trozos espaciados, como un streaming de verdad. */
import { expect, test, type Page } from "@playwright/test";

const lista = (page: Page) => page.getByTestId("chat-mensajes");
const scroll = (page: Page) => lista(page).evaluate((el) => ({ top: el.scrollTop, alto: el.scrollHeight, visible: el.clientHeight }));
const abajo = async (page: Page) => {
  const s = await scroll(page);
  return s.alto - s.top - s.visible < 4;
};

test("mientras se genera, subir mantiene la posición; «Ir al final» vuelve y reanuda el seguimiento", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/#/chat");
  await page.getByTestId("chat-input").fill("E2E-LENTO respóndeme largo");
  await page.getByTestId("chat-enviar").click();

  // Mientras el usuario no toca nada, la vista sigue el final.
  await expect.poll(async () => (await scroll(page)).alto - (await scroll(page)).visible, { timeout: 10_000 }).toBeGreaterThan(600);
  expect(await abajo(page)).toBe(true);
  await expect(page.getByTestId("chat-ir-al-final")).toHaveCount(0);

  // Sube con la rueda: la posición no se mueve aunque siga entrando texto.
  await lista(page).hover();
  await page.mouse.wheel(0, -500);
  await expect.poll(async () => (await scroll(page)).top).toBeLessThan((await scroll(page)).alto - (await scroll(page)).visible - 300);
  const fija = (await scroll(page)).top;
  const altoAntes = (await scroll(page)).alto;
  await page.waitForTimeout(1000);
  expect((await scroll(page)).alto).toBeGreaterThan(altoAntes); // sigue entrando contenido
  expect(Math.abs((await scroll(page)).top - fija)).toBeLessThanOrEqual(2);
  await expect(page.getByTestId("chat-ir-al-final")).toBeVisible();

  // «Ir al final» baja y el seguimiento se reanuda con lo que sigue llegando.
  await page.getByTestId("chat-ir-al-final").click();
  await expect.poll(() => abajo(page)).toBe(true);
  await expect(page.getByTestId("chat-ir-al-final")).toHaveCount(0);
  const altoTrasVolver = (await scroll(page)).alto;
  await expect.poll(async () => (await scroll(page)).alto).toBeGreaterThan(altoTrasVolver);
  expect(await abajo(page)).toBe(true);

  await expect(page.getByTestId("chat-enviar")).toBeVisible({ timeout: 15_000 }); // turno terminado
  expect(await abajo(page)).toBe(true);
});

test("volver abajo con la rueda también reanuda el seguimiento", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/#/chat");
  await page.getByTestId("chat-input").fill("E2E-LENTO otra vez");
  await page.getByTestId("chat-enviar").click();
  await expect.poll(async () => (await scroll(page)).alto - (await scroll(page)).visible, { timeout: 10_000 }).toBeGreaterThan(600);
  await lista(page).hover();
  await page.mouse.wheel(0, -500);
  await expect(page.getByTestId("chat-ir-al-final")).toBeVisible();
  await page.mouse.wheel(0, 100_000);
  await expect.poll(() => abajo(page)).toBe(true);
  const alto = (await scroll(page)).alto;
  await expect.poll(async () => (await scroll(page)).alto).toBeGreaterThan(alto);
  expect(await abajo(page)).toBe(true);
  await expect(page.getByTestId("chat-ir-al-final")).toHaveCount(0);
});
