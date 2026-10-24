/** Onboarding como asistente de bienvenida: ancho completo, sin barra lateral, un paso visible cada vez. */
import { expect, test } from "@playwright/test";
import { api, settings, youtube } from "./api";
import { simularRutas } from "./sidecar-falso";

const ESTADO_AUTORIZADO = {
  auth: { profile: "default", profiles: ["default"], authenticated: true, store: "FileSecretStore" },
  quota: { buckets: { general: { used: 0, limit: 10000 }, search: { used: 0, limit: 100 }, video_insert: { used: 0, limit: 100 } } },
};

test.describe("Onboarding", () => {
  test.beforeAll(async () => {
    // El primer paso (clave) debe estar hecho para poder llegar a los siguientes.
    if (!(await settings()).has_anthropic_key) {
      await api("/settings", { method: "PUT", body: JSON.stringify({ anthropic_api_key: "sk-ant-onboarding-e2e" }) });
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.goto("/#/onboarding");
    await expect(page.getByTestId("onboarding-pasos")).toBeAttached();
  });

  test("a ancho completo y sin barra lateral; un paso visible cada vez y progreso arriba", async ({ page }) => {
    await expect(page.getByTestId("nav")).toHaveCount(0);
    const s = await settings();
    const pasos = page.getByTestId("onboarding-pasos").locator("> li");
    await expect(pasos).toHaveCount(4);
    await expect(pasos.locator(":scope:visible")).toHaveCount(1);
    // con la clave hecha, el asistente abre en el primer paso pendiente (Google Cloud si falta el client_secret)
    const esperado = s.has_client_secret ? "paso-oauth" : "paso-google";
    await expect(page.getByTestId(esperado)).toBeVisible();
    await expect(page.getByTestId("onboarding-progreso")).toHaveText(s.has_client_secret ? "Paso 3 de 4" : "Paso 2 de 4");
    await expect(page.getByRole("progressbar", { name: "Progreso de la configuración" })).toBeVisible();
    const ancho = await page.getByTestId("onboarding").evaluate((e) => e.getBoundingClientRect().width);
    expect(Math.round(ancho)).toBe(page.viewportSize()!.width);
  });

  test("cuatro pasos en orden con estado coherente con el sidecar", async ({ page }) => {
    const s = await settings();
    const yt = await youtube();
    const pasos = page.getByTestId("onboarding-pasos").locator("> li");
    expect(await pasos.evaluateAll((l) => l.map((e) => e.getAttribute("data-testid")))).toEqual(["paso-clave", "paso-google", "paso-oauth", "paso-kb"]);
    await expect(page.getByTestId("paso-clave")).toHaveAttribute("data-estado", s.has_anthropic_key ? "hecho" : "pendiente");
    await expect(page.getByTestId("paso-google")).toHaveAttribute("data-estado", s.has_client_secret ? "hecho" : "pendiente");
    await expect(page.getByTestId("paso-oauth")).toHaveAttribute("data-estado", yt.auth.authenticated ? "hecho" : "pendiente");
    await expect(page.getByTestId("paso-kb")).toHaveAttribute("data-estado", /hecho|pendiente/);
    const listo = s.has_anthropic_key && s.has_client_secret && yt.auth.authenticated;
    await expect(page.getByTestId("onboarding-terminar")).toHaveText("Ir al chat");
    if (listo) await expect(page.getByTestId("onboarding-terminar")).toBeEnabled();
    else await expect(page.getByTestId("onboarding-terminar")).toBeDisabled();
  });

  test("clave: se valida con Anthropic antes de guardarla; una mala no se guarda", async ({ page }) => {
    await page.getByTestId("onboarding-ir-paso-clave").click();
    await expect(page.getByTestId("paso-clave")).toBeVisible();
    await expect(page.getByTestId("clave-guardar")).toBeDisabled();
    const antes = await settings();
    await page.getByTestId("clave-input").fill("sk-ant-esta-es-mala");
    await page.getByTestId("clave-guardar").click();
    await expect(page.getByTestId("clave-error")).toHaveText("Anthropic no reconoce esta clave.");
    expect((await settings()).has_anthropic_key).toBe(antes.has_anthropic_key);

    await page.getByTestId("clave-input").fill("sk-ant-esta-es-buena");
    await page.getByTestId("clave-guardar").click();
    await expect(page.getByRole("status").filter({ hasText: "Clave validada y guardada" }).first()).toBeVisible();
    await expect(page.getByTestId("clave-input")).toHaveValue("");
    expect((await settings()).has_anthropic_key).toBe(true);
    expect(await page.content()).not.toContain("sk-ant-esta-es-buena");
  });

  test("Google Cloud: la checklist es informativa y no bloquea; el validador rechaza JSON malos sin llamar al sidecar", async ({ page }) => {
    const s = await settings();
    test.skip(s.has_client_secret, "las credenciales ya están importadas en este sidecar");
    const llamadas: string[] = [];
    page.on("request", (r) => r.url().includes("/settings/client-secret") && llamadas.push(r.url()));
    await expect(page.getByTestId("paso-google")).toBeVisible();
    await expect(page.getByTestId("google-importar")).toBeEnabled(); // sin marcar nada
    await expect(page.getByTestId("google-paso-a")).not.toBeChecked();

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

    // la zona de soltar valida el fichero al recibirlo
    await page.getByTestId("google-fichero").setInputFiles({ name: "malo.json", mimeType: "application/json", buffer: Buffer.from('{"web":{}}') });
    await expect(page.getByTestId("google-error")).toContainText("Aplicación de escritorio");
    expect(llamadas).toEqual([]);
  });

  test("Google Cloud: un JSON soltado en la zona se importa y el paso queda hecho", async ({ page }) => {
    test.skip((await settings()).has_client_secret, "las credenciales ya están importadas en este sidecar");
    const json = JSON.stringify({ installed: { client_id: "id-e2e.apps.googleusercontent.com", client_secret: "secreto-e2e", auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token", redirect_uris: ["http://localhost"] } });
    await page.getByTestId("google-fichero").setInputFiles({ name: "client_secret.json", mimeType: "application/json", buffer: Buffer.from(json) });
    await expect(page.getByTestId("google-json")).toHaveValue(json);
    await expect(page.getByTestId("google-error")).toHaveCount(0);
    await page.getByTestId("google-importar").click();
    await expect(page.getByTestId("paso-google")).toHaveAttribute("data-estado", "hecho");
    expect((await settings()).has_client_secret).toBe(true);
    await expect(page.getByTestId("onboarding-progreso")).toHaveText("Paso 3 de 4"); // avanza solo al siguiente pendiente
    await expect(page.getByTestId("oauth-autorizar")).toBeEnabled();
    await expect(page.getByTestId("oauth-no-verificada")).toContainText("no ha verificado esta app");
  });

  test("con todo hecho: navegar entre pasos, ver la KB y terminar en un chat de bienvenida con sugerencias", async ({ page }) => {
    await simularRutas(page, { "/youtube/status": ESTADO_AUTORIZADO });
    await page.reload(); // el beforeEach ya cargó la app: recargamos para que use el estado simulado
    await expect(page.getByTestId("onboarding-progreso")).toHaveText("Paso 1 de 4"); // todo hecho: se abre en el primero
    await expect(page.getByTestId("paso-clave")).toBeVisible();
    await expect(page.getByTestId("onboarding-atras")).toBeDisabled();
    await page.getByTestId("onboarding-continuar").click();
    await expect(page.getByTestId("paso-google")).toBeVisible();
    await page.getByTestId("onboarding-continuar").click();
    await expect(page.getByTestId("paso-oauth")).toBeVisible();
    await page.getByTestId("onboarding-continuar").click();
    await expect(page.getByTestId("paso-kb")).toBeVisible();
    await expect(page.getByTestId("kb-estado-texto")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("onboarding-continuar")).toHaveCount(0); // último paso
    await page.getByTestId("onboarding-atras").click();
    await expect(page.getByTestId("paso-oauth")).toBeVisible();
    await page.getByTestId("onboarding-ir-paso-kb").click();

    await page.getByTestId("onboarding-terminar").click();
    await expect(page).toHaveURL(/#\/chat$/);
    await expect(page.getByTestId("chat-bienvenida")).toContainText("¡Todo listo!");
    await expect(page.getByTestId("nav")).toBeVisible(); // al salir del asistente vuelve la barra lateral
    await expect(page.locator('[data-testid^="chat-sugerencia-"]')).toHaveCount(3);
    await page.getByTestId("chat-sugerencia-2").click();
    await expect(page.getByTestId("msg-user")).toContainText("mejor hora para publicar Shorts");
    await expect(page.getByTestId("chat-bienvenida")).toHaveCount(0);
  });

  test("paso de la KB muestra el estado del sidecar", async ({ page }) => {
    await simularRutas(page, { "/youtube/status": ESTADO_AUTORIZADO });
    await page.reload(); // el beforeEach ya cargó la app: recargamos para que use el estado simulado
    await page.getByTestId("onboarding-ir-paso-kb").click();
    await expect(page.getByTestId("paso-kb").locator("pre, [role=alert], .error").first()).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("Onboarding: autorización interrumpida (sidecar simulado)", () => {
  test("si el navegador no vuelve de Google, Cancelar devuelve el control y se puede reintentar", async ({ page }) => {
    const s = await settings();
    let responder: (r: [number, unknown]) => void = () => undefined;
    const llamadas = await simularRutas(page, {
      "/settings": { ...s, has_anthropic_key: true, has_client_secret: true },
      "/youtube/status": { ...ESTADO_AUTORIZADO, auth: { ...ESTADO_AUTORIZADO.auth, authenticated: false } },
      "/youtube/auth": () => new Promise<[number, unknown]>((r) => (responder = r)),
      "/youtube/auth/cancel": () => {
        responder([400, { detail: "Autorización cancelada." }]);
        return [200, { cancelada: true }];
      },
    });
    await page.goto("/#/onboarding");
    const autorizar = page.getByTestId("oauth-autorizar");
    await autorizar.click();
    await expect(autorizar).toHaveText("Se ha abierto el navegador…");
    await page.getByTestId("oauth-cancelar").click();
    await expect(page.getByTestId("oauth-error")).toHaveText("Autorización cancelada.");
    await expect(autorizar).toHaveText("Autorizar canal de YouTube");
    await expect(autorizar).toBeEnabled();
    await expect(page.getByTestId("oauth-cancelar")).toHaveCount(0);
    expect(llamadas["/youtube/auth/cancel"]).toBe(1);
  });
});
