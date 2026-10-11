import { expect, test } from "@playwright/test";
import { settings, youtube } from "./api";

test.describe("Ajustes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/ajustes");
    await expect(page.getByTestId("ajustes-form")).toBeVisible();
  });

  test("modelo: opciones del sidecar, guardar deshabilitado sin cambios, cambio persistido", async ({ page }) => {
    const s = await settings();
    const select = page.getByTestId("ajustes-model");
    await expect(select).toHaveValue(s.model);
    expect(await select.locator("option").allTextContents()).toEqual(s.models);
    await expect(page.getByTestId("ajustes-guardar")).toBeDisabled();

    const otro = s.models.find((m) => m !== s.model)!;
    await select.selectOption(otro);
    await expect(page.getByTestId("ajustes-guardar")).toBeEnabled();
    await page.getByTestId("ajustes-guardar").click();
    await expect(page.getByTestId("ajustes-ok")).toHaveText("Guardado");
    expect((await settings()).model).toBe(otro);
    await expect(page.getByTestId("ajustes-guardar")).toBeDisabled();
    await expect(page.getByTestId("ajustes-ok")).toBeHidden({ timeout: 5000 });

    await select.selectOption(s.model);
    await page.getByTestId("ajustes-guardar").click();
    await expect(page.getByTestId("ajustes-ok")).toBeVisible();
  });

  test("clave de Anthropic: se envía una vez, el campo queda vacío y nunca se muestra", async ({ page }) => {
    const campo = page.getByTestId("ajustes-key");
    await expect(campo).toHaveAttribute("type", "password");
    await expect(campo).toHaveValue("");
    await expect(page.getByTestId("ajustes-key-guardar")).toBeDisabled();
    await campo.fill("sk-ant-otra-clave-e2e");
    await page.getByTestId("ajustes-key-guardar").click();
    await expect(page.getByTestId("ajustes-ok")).toBeVisible();
    await expect(campo).toHaveValue("");
    await expect(page.getByTestId("ajustes-key-estado")).toContainText("Guardada en");
    await expect(page.getByTestId("ajustes-key-borrar")).toBeVisible();
    expect((await settings()).has_anthropic_key).toBe(true);
    expect(await page.content()).not.toContain("sk-ant-otra-clave-e2e");
  });

  test("carpetas permitidas: alta y baja reflejadas en el sidecar", async ({ page }) => {
    const antes = (await settings()).allowed_dirs.length;
    await expect(page.getByTestId("ajustes-dir")).toHaveCount(antes);
    await expect(page.getByTestId("ajustes-dir-add")).toBeDisabled();
    await page.getByTestId("ajustes-dir-path").fill("C:\\Users\\Marc\\Videos\\E2E");
    await page.getByTestId("ajustes-dir-lang").fill("en");
    await page.getByTestId("ajustes-dir-add").click();
    await expect(page.getByTestId("ajustes-dir")).toHaveCount(antes + 1);
    await page.getByTestId("ajustes-guardar").click();
    await expect(page.getByTestId("ajustes-ok")).toBeVisible();
    const tras = (await settings()).allowed_dirs;
    expect(tras).toContainEqual({ path: "C:\\Users\\Marc\\Videos\\E2E", language: "en" });

    await page.getByTestId("ajustes-dir").last().getByRole("button", { name: "Quitar" }).click();
    await page.getByTestId("ajustes-guardar").click();
    await expect(page.getByTestId("ajustes-ok")).toBeVisible();
    expect((await settings()).allowed_dirs.length).toBe(antes);
  });

  test("perfil, estado OAuth y cuota coinciden con el sidecar", async ({ page }) => {
    const yt = await youtube();
    const s = await settings();
    await expect(page.getByTestId("ajustes-profile")).toHaveValue(s.profile);
    expect(await page.getByTestId("ajustes-profile").locator("option").allTextContents()).toEqual([...new Set([...yt.auth.profiles, s.profile])]);
    await expect(page.getByTestId("ajustes-yt-estado")).toHaveText(yt.auth.authenticated ? "Autorizado" : "Sin autorizar");
    await expect(page.getByTestId("ajustes-yt-reauth")).toHaveText("Volver a autorizar");
    for (const [b, v] of Object.entries(yt.quota.buckets)) {
      await expect(page.getByTestId(`cuota-${b}`)).toContainText(`${v.used} / ${v.limit}`);
    }
    await expect(page.locator("main")).toContainText(s.state_dir);
    await expect(page.locator("main")).toContainText(s.secret_store);
  });
});
