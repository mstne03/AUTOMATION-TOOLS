/** Catálogo de componentes (/#/catalogo, solo en desarrollo): los dos temas a la vez y manejo por teclado. */
import { expect, test } from "@playwright/test";

test.describe("Catálogo de componentes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/catalogo");
    await expect(page.getByTestId("catalogo")).toBeVisible();
  });

  test("pinta los componentes en oscuro y claro con los colores de los tokens", async ({ page }) => {
    const fondo = (id: string) => page.getByTestId(id).evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(await fondo("catalogo-oscuro")).toBe("rgb(11, 11, 15)");
    expect(await fondo("catalogo-claro")).toBe("rgb(250, 250, 250)");
    for (const id of ["catalogo-oscuro", "catalogo-claro"]) {
      const panel = page.getByTestId(id);
      await expect(panel.getByRole("button", { name: "Primario" })).toBeVisible();
      await expect(panel.getByRole("radiogroup", { name: "Visibilidad" })).toBeVisible();
      await expect(panel.getByText("destructiva")).toBeVisible();
      await expect(panel.getByText("Sin resultados")).toBeVisible();
    }
  });

  test("botones de la escala sm/md/lg: 32, 36 y 44 px de alto", async ({ page }) => {
    const panel = page.getByTestId("catalogo-oscuro");
    const alto = async (nombre: string) => Math.round((await panel.getByRole("button", { name: nombre }).boundingBox())!.height);
    expect(await alto("sm 32")).toBe(32);
    expect(await alto("md 36")).toBe(36);
    expect(await alto("lg 44")).toBe(44);
  });

  test("el contador del campo se actualiza al escribir y se marca al pasarse del máximo", async ({ page }) => {
    const campo = page.getByTestId("catalogo-oscuro").getByLabel("Título", { exact: true });
    const contador = page.getByTestId("catalogo-oscuro").getByTestId("field-contador").first();
    await campo.fill("hola");
    await expect(contador).toHaveText("4 / 100");
    await campo.fill("x".repeat(101));
    await expect(contador).toHaveText("101 / 100");
    await expect(campo).toHaveAttribute("aria-invalid", "true");
  });

  test("SegmentedControl: una parada de tabulador y flechas que seleccionan", async ({ page }) => {
    const grupo = page.getByTestId("catalogo-claro").getByRole("radiogroup", { name: "Visibilidad" });
    await grupo.getByRole("radio", { name: "Privado" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(grupo.getByRole("radio", { name: "Oculto" })).toBeChecked();
    await expect(grupo.getByRole("radio", { name: "Oculto" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(grupo.getByRole("radio", { name: "Público" })).toBeChecked();
  });

  test("el foco con teclado se ve (anillo de 2 px de acento)", async ({ page }) => {
    const boton = page.getByTestId("catalogo-oscuro").getByRole("button", { name: "Primario" });
    await boton.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab"); // vuelve con teclado: :focus-visible
    await expect(boton).toBeFocused();
    const o = await boton.evaluate((e) => {
      const c = getComputedStyle(e);
      return { ancho: c.outlineWidth, estilo: c.outlineStyle, offset: c.outlineOffset };
    });
    expect(o).toEqual({ ancho: "2px", estilo: "solid", offset: "2px" });
  });
});
