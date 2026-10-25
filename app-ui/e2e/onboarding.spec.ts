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
    // Siempre hay salida: con todo hecho, "Ir al chat"; si falta algo, "Terminar más tarde".
    await expect(page.getByTestId("onboarding-terminar")).toHaveText(listo ? "Ir al chat" : "Terminar más tarde");
    await expect(page.getByTestId("onboarding-terminar")).toBeEnabled();
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
    // todo hecho: se abre en el final ("Todo listo"), no en un paso ya hecho
    await expect(page.getByTestId("onboarding-progreso")).toHaveText("Paso 4 de 4");
    await expect(page.getByTestId("paso-kb")).toBeVisible();
    await expect(page.getByTestId("onboarding-listo")).toContainText("Todo listo");
    await expect(page.getByTestId("kb-estado-texto")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("onboarding-continuar")).toHaveCount(0); // último paso
    await page.getByTestId("onboarding-ir-paso-clave").click();
    await expect(page.getByTestId("paso-clave")).toBeVisible();
    await expect(page.getByTestId("onboarding-atras")).toBeDisabled();
    await page.getByTestId("onboarding-continuar").click();
    await expect(page.getByTestId("paso-google")).toBeVisible();
    await page.getByTestId("onboarding-continuar").click();
    await expect(page.getByTestId("paso-oauth")).toBeVisible();
    await page.getByTestId("onboarding-continuar").click();
    await expect(page.getByTestId("paso-kb")).toBeVisible();
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
    // Mientras espera: qué hacer si Google bloquea la cuenta (no es usuario de prueba del proyecto).
    await expect(page.getByTestId("oauth-ayuda-google")).toContainText("usuario de prueba");
    await page.getByTestId("oauth-cancelar").click();
    await expect(page.getByTestId("oauth-error")).toHaveText("Autorización cancelada.");
    await expect(page.getByTestId("oauth-ayuda-google")).toHaveCount(0);
    await expect(autorizar).toHaveText("Autorizar canal de YouTube");
    await expect(autorizar).toBeEnabled();
    await expect(page.getByTestId("oauth-cancelar")).toHaveCount(0);
    expect(llamadas["/youtube/auth/cancel"]).toBe(1);
    // El fallo lleva a revisar el proyecto de Google.
    await page.getByTestId("oauth-ir-google").click();
    await expect(page.getByTestId("paso-google")).toBeVisible();
  });
});

test.describe("Onboarding: elegir el client_secret.json", () => {
  const RUTA = String.raw`C:\Users\Marc\.secrets\client_secret.json`;

  test("en la app de escritorio, 'Elegir fichero…' muestra el fichero elegido y no hay un segundo selector", async ({ page }) => {
    const s = await settings();
    const sidecar = new URL(process.env.E2E_SIDECAR!);
    // Tauri simulado: el sidecar sale de sidecar_info y el explorador nativo devuelve RUTA.
    await page.addInitScript(
      ({ port, token, ruta }) => {
        (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
          invoke: async (cmd: string) => (cmd === "sidecar_info" ? { port, token } : cmd === "elegir_client_secret" ? ruta : null),
          transformCallback: () => 0,
        };
      },
      { port: Number(sidecar.port), token: process.env.E2E_TOKEN!, ruta: RUTA },
    );
    await simularRutas(page, { "/settings": { ...s, has_anthropic_key: true, has_client_secret: false } });
    await page.goto("/#/onboarding");
    await expect(page.getByTestId("paso-google")).toBeVisible();
    await expect(page.getByTestId("google-fichero")).toHaveCount(0); // un solo selector
    await page.getByTestId("google-elegir").click();
    await expect(page.getByTestId("google-elegido")).toHaveText("client_secret.json listo para importar");
    await expect(page.getByTestId("google-elegir")).toHaveText("Elegir otro…");
    await expect(page.getByTestId("google-path")).toHaveValue(RUTA);
    await page.getByTestId("google-path").fill(""); // si se edita a mano, deja de ser "el fichero elegido"
    await expect(page.getByTestId("google-elegido")).toHaveCount(0);
  });

  test("en el navegador, el selector de ficheros también muestra el fichero elegido", async ({ page }) => {
    const s = await settings();
    await simularRutas(page, { "/settings": { ...s, has_anthropic_key: true, has_client_secret: false } });
    await page.goto("/#/onboarding");
    await expect(page.getByTestId("google-elegir")).toHaveCount(0); // sin Tauri no hay explorador nativo
    await page.getByTestId("google-fichero").setInputFiles({ name: "mi_secreto.json", mimeType: "application/json", buffer: Buffer.from('{"installed":{}}') });
    await expect(page.getByTestId("google-elegido")).toHaveText("mi_secreto.json listo para importar");
  });
});

test.describe("Onboarding: recorrido desde el aviso de configuración (sidecar simulado)", () => {
  /** Clave y client_secret hechos; el canal sin autorizar hasta que POST /youtube/auth responde. */
  async function conCanalPendiente(page: import("@playwright/test").Page, auth: Record<string, unknown> = {}) {
    const s = await settings();
    let autorizado = false;
    const peticiones: unknown[] = [];
    await simularRutas(page, {
      "/settings": { ...s, has_anthropic_key: true, has_client_secret: true },
      "/youtube/status": () => [200, { ...ESTADO_AUTORIZADO, auth: { ...ESTADO_AUTORIZADO.auth, authenticated: autorizado, ...(autorizado ? {} : auth) } }],
      "/youtube/auth": (_u, p) => {
        peticiones.push(p.cuerpo);
        autorizado = true;
        return [200, { status: "authenticated", detail: { ...ESTADO_AUTORIZADO.auth, authenticated: true }, duplicated_in: [] }];
      },
    });
    return peticiones;
  }

  test("al autorizar el canal pendiente, termina en 'Todo listo' y no vuelve a un paso hecho", async ({ page }) => {
    await conCanalPendiente(page);
    await page.goto("/#/chat");
    await page.getByTestId("nav-onboarding").click();
    await expect(page.getByTestId("paso-oauth")).toBeVisible();
    await page.getByTestId("oauth-autorizar").click();
    await expect(page.getByRole("status").filter({ hasText: "Canal autorizado" }).first()).toBeVisible();
    await expect(page.getByTestId("paso-kb")).toBeVisible();
    await expect(page.getByTestId("onboarding-progreso")).toHaveText("Paso 4 de 4");
    await expect(page.getByTestId("onboarding-listo")).toContainText("Todo listo");
    await expect(page.getByTestId("onboarding-terminar")).toBeEnabled();
  });

  test("si se navega a mano a un paso pendiente y se completa, avanza al siguiente", async ({ page }) => {
    await conCanalPendiente(page);
    await page.goto("/#/onboarding");
    await page.getByTestId("onboarding-ir-paso-google").click(); // el usuario vuelve atrás
    await page.getByTestId("onboarding-continuar").click(); // y avanza a mano al de autorizar
    await page.getByTestId("oauth-autorizar").click();
    await expect(page.getByTestId("paso-kb")).toBeVisible();
  });

  test("con el canal ya autorizado, el paso lo dice y 'Volver a autorizar' fuerza el consentimiento", async ({ page }) => {
    const peticiones = await conCanalPendiente(page);
    await page.goto("/#/onboarding");
    await page.getByTestId("oauth-autorizar").click(); // primera autorización
    await expect(page.getByTestId("paso-kb")).toBeVisible();
    await page.getByTestId("onboarding-ir-paso-oauth").click();
    await expect(page.getByTestId("oauth-estado")).toHaveText("Canal autorizado · perfil default");
    await expect(page.getByTestId("oauth-autorizar")).toHaveText("Volver a autorizar");
    await page.getByTestId("oauth-autorizar").click();
    await expect.poll(() => peticiones.length).toBe(2);
    expect(peticiones).toEqual([{}, { reauthorize: true }]);
  });

  test("el paso de autorizar dice qué canal está autorizado y el de Google, qué proyecto", async ({ page }) => {
    const s = await settings();
    await simularRutas(page, {
      "/settings": { ...s, has_anthropic_key: true, has_client_secret: true, google_project: { project_id: "mi-proyecto", client_id: "123456…wxyz" } },
      "/youtube/status": { ...ESTADO_AUTORIZADO, auth: { ...ESTADO_AUTORIZADO.auth, channel: { id: "UC1", title: "Canal A", handle: "@a" } } },
    });
    await page.goto("/#/onboarding");
    await page.getByTestId("onboarding-ir-paso-oauth").click();
    await expect(page.getByTestId("oauth-estado")).toHaveText("Canal autorizado · Canal A (@a)");
    await page.getByTestId("onboarding-ir-paso-google").click();
    await expect(page.getByTestId("google-proyecto")).toHaveText("Proyecto mi-proyecto · cliente 123456…wxyz");
  });

  test("si el canal no se puede autorizar, se puede salir del asistente y terminar más tarde", async ({ page }) => {
    await conCanalPendiente(page, { reason: "Este canal se autorizó con otro proyecto de Google: vuelve a autorizarlo." });
    await page.goto("/#/onboarding");
    await expect(page.getByTestId("oauth-motivo")).toContainText("otro proyecto de Google");
    await expect(page.getByTestId("onboarding-continuar")).toBeDisabled();
    const salir = page.getByTestId("onboarding-terminar");
    await expect(salir).toHaveText("Terminar más tarde");
    await salir.click();
    await expect(page).toHaveURL(/#\/chat$/);
    await expect(page.getByTestId("chat-bienvenida")).toHaveCount(0); // el "¡Todo listo!" es solo con todo hecho
    await expect(page.getByTestId("nav-onboarding")).toBeVisible(); // el aviso recuerda lo que falta
  });

  test("si Google rechazó la autorización guardada, el paso explica el motivo", async ({ page }) => {
    await conCanalPendiente(page, { expired: true, reason: "Google ha rechazado la autorización guardada: vuelve a autorizar el canal." });
    await page.goto("/#/onboarding");
    await expect(page.getByTestId("oauth-motivo")).toContainText("vuelve a autorizar el canal");
  });
});
