import { expect, test } from "@playwright/test";
import { settings, youtube } from "./api";

test.describe("Onboarding", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/onboarding");
    await expect(page.getByTestId("onboarding-pasos")).toBeVisible();
  });

  test("cuatro pasos en orden con estado coherente con el sidecar", async ({ page }) => {
    const s = await settings();
    const yt = await youtube();
    const pasos = page.getByTestId("onboarding-pasos").locator("> li");
    expect(await pasos.evaluateAll((l) => l.map((e) => e.getAttribute("data-testid")))).toEqual([
      "paso-clave",
      "paso-google",
      "paso-oauth",
      "paso-kb",
    ]);
    await expect(page.getByTestId("paso-clave")).toHaveAttribute("data-estado", s.has_anthropic_key ? "hecho" : "pendiente");
    await expect(page.getByTestId("paso-google")).toHaveAttribute("data-estado", s.has_client_secret ? "hecho" : "pendiente");
    await expect(page.getByTestId("paso-oauth")).toHaveAttribute("data-estado", yt.auth.authenticated ? "hecho" : "pendiente");
    await expect(page.getByTestId("paso-kb")).toHaveAttribute("data-estado", /hecho|pendiente/);
    const listo = s.has_anthropic_key && s.has_client_secret && yt.auth.authenticated;
    await expect(page.getByTestId("onboarding-terminar")).toHaveText("Ir al chat");
    if (listo) await expect(page.getByTestId("onboarding-terminar")).toBeEnabled();
    else await expect(page.getByTestId("onboarding-terminar")).toBeDisabled();
  });

  test("asistente de Google: el validador rechaza JSON malos sin llamar al sidecar", async ({ page }) => {
    const llamadas: string[] = [];
    page.on("request", (r) => r.url().includes("/settings/client-secret") && llamadas.push(r.url()));
    // Importar exige marcar los dos sub-pasos manuales.
    await expect(page.getByTestId("google-importar")).toBeDisabled();
    await page.getByTestId("google-paso-a").check();
    await page.getByTestId("google-paso-b").check();
    await expect(page.getByTestId("google-importar")).toBeEnabled();

    await page.getByTestId("google-importar").click();
    await expect(page.getByTestId("google-error")).toContainText("Pega el JSON");
    await page.getByTestId("google-json").fill("{no es json");
    await page.getByTestId("google-importar").click();
    await expect(page.getByTestId("google-error")).toHaveText("No es JSON válido.");
    await page.getByTestId("google-json").fill(JSON.stringify({ web: { client_id: "x" } }));
    await page.getByTestId("google-importar").click();
    await expect(page.getByTestId("google-error")).toContainText("Aplicación de escritorio");
    await page.getByTestId("google-json").fill(JSON.stringify({ installed: { client_id: "x" } }));
    await page.getByTestId("google-importar").click();
    await expect(page.getByTestId("google-error")).toContainText("client_secret");
    expect(llamadas).toEqual([]);
  });

  test("asistente de Google: un JSON válido se importa y el paso queda hecho", async ({ page }) => {
    await page.getByTestId("google-paso-a").check();
    await page.getByTestId("google-paso-b").check();
    await page.getByTestId("google-json").fill(
      JSON.stringify({ installed: { client_id: "id-e2e.apps.googleusercontent.com", client_secret: "secreto-e2e", auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token", redirect_uris: ["http://localhost"] } }),
    );
    await page.getByTestId("google-importar").click();
    await expect(page.getByTestId("paso-google")).toHaveAttribute("data-estado", "hecho");
    expect((await settings()).has_client_secret).toBe(true);
    await expect(page.getByTestId("oauth-autorizar")).toBeEnabled();
  });

  test("paso de la KB muestra el texto del sidecar", async ({ page }) => {
    const paso = page.getByTestId("paso-kb");
    await expect(paso.locator("pre, .error")).toBeVisible({ timeout: 30_000 });
  });
});
