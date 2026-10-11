import { expect, test } from "@playwright/test";
import { api } from "./api";

test.describe("Base de conocimiento", () => {
  test("estado, búsqueda y fuentes muestran el texto del sidecar", async ({ page }) => {
    const estado = await api<{ texto: string }>("/kb/estado");
    await page.goto("/#/kb");
    await expect(page.getByTestId("kb-estado")).toHaveText(estado.texto, { timeout: 30_000 });

    const select = page.getByTestId("kb-plataforma");
    expect(await select.locator("option").allTextContents()).toEqual(["todas", "youtube", "tiktok", "instagram", "linkedin", "x"]);
    await expect(page.getByTestId("kb-buscar-btn")).toBeDisabled();
    await page.getByTestId("kb-q").fill("hashtags");
    await select.selectOption("tiktok");
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/kb/buscar")),
      page.getByTestId("kb-buscar-btn").click(),
    ]);
    const url = new URL(req.url());
    expect(url.searchParams.get("q")).toBe("hashtags");
    expect(url.searchParams.get("plataforma")).toBe("tiktok");
    expect(url.searchParams.get("k")).toBe("5");
    const esperado = await api<{ texto: string }>("/kb/buscar?q=hashtags&plataforma=tiktok&k=5");
    await expect(page.getByTestId("kb-resultado")).toHaveText(esperado.texto, { timeout: 60_000 });

    const fuentes = await api<{ texto: string }>("/kb/fuentes?plataforma=tiktok");
    await page.getByTestId("kb-fuentes").click();
    await expect(page.getByTestId("kb-fuentes-texto")).toHaveText(fuentes.texto, { timeout: 30_000 });
  });
});
