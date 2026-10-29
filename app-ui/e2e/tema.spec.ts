import { expect, test } from "@playwright/test";

const fondo = (page: import("@playwright/test").Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe("Tokens: tema y fuentes", () => {
  test("data-theme alterna claro y oscuro sin recargar", async ({ page }) => {
    await page.goto("/#/kb");
    await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
    expect(await fondo(page)).toBe("rgb(11, 11, 15)");
    await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
    expect(await fondo(page)).toBe("rgb(250, 250, 250)");
    await page.evaluate(() => delete document.documentElement.dataset.theme);
  });

  test("sin data-theme se sigue al sistema", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/#/kb");
    expect(await fondo(page)).toBe("rgb(250, 250, 250)");
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await fondo(page)).toBe("rgb(11, 11, 15)");
  });

  test("Inter y JetBrains Mono se cargan desde el bundle", async ({ page }) => {
    await page.goto("/#/kb");
    const cargadas = await page.evaluate(async () => {
      await document.fonts.load('14px "Inter Variable"', "áñ");
      await document.fonts.load('14px "JetBrains Mono"', "abc");
      return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, ""));
    });
    expect(cargadas).toContain("Inter Variable");
    expect(cargadas).toContain("JetBrains Mono");
  });
});
