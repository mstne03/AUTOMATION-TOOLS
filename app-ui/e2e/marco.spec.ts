import { expect, test } from "@playwright/test";
import { settings, youtube } from "./api";

test("barra lateral: título, enlaces en orden, activo con aria-current y 248 px", async ({ page }) => {
  const s = await settings();
  const yt = await youtube();
  await page.goto("/#/kb");
  const nav = page.getByTestId("nav");
  await expect(nav.locator("h2")).toHaveText("SEO Studio");
  const ids = await nav.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("data-testid")));
  const falta = !s.has_anthropic_key || !s.has_client_secret || !yt.auth.authenticated;
  expect(ids).toEqual(["nav-chat", "nav-publicar", "nav-guiones", "nav-canal", "nav-kb", ...(falta ? ["nav-onboarding"] : []), "nav-ajustes"]);
  await expect(page.getByTestId("nav-kb")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("nav-chat")).not.toHaveAttribute("aria-current", "page");
  for (const [id, texto] of [["nav-chat", "Chat"], ["nav-publicar", "Publicar"], ["nav-guiones", "Guiones"], ["nav-canal", "Canal"], ["nav-kb", "Conocimiento"]]) {
    await expect(page.getByTestId(id)).toHaveText(texto);
  }
  const ancho = await nav.evaluate((n) => n.getBoundingClientRect().width);
  expect(Math.round(ancho)).toBe(248);
  const alto = await nav.evaluate((n) => n.getBoundingClientRect().height);
  expect(Math.round(alto)).toBe(page.viewportSize()!.height); // la barra ocupa toda la altura de la ventana
});

test("el aviso de configuración solo aparece si falta algún paso y lleva al onboarding", async ({ page }) => {
  const s = await settings();
  const yt = await youtube();
  await page.goto("/#/kb");
  const falta = !s.has_anthropic_key || !s.has_client_secret || !yt.auth.authenticated;
  await expect(page.getByTestId("nav-onboarding")).toHaveCount(falta ? 1 : 0);
  if (falta) {
    await page.getByTestId("nav-onboarding").click();
    await expect(page).toHaveURL(/#\/onboarding$/);
  }
});

test("conversaciones: la lista refleja el primer mensaje y 'Nueva' abre otra vacía", async ({ page }) => {
  await page.goto("/#/chat");
  await expect(page.getByTestId("conv-chat:1")).toHaveText("Nueva conversación");
  await page.getByTestId("chat-input").fill("Hola E2E-TEXTO para la lista");
  await page.getByTestId("chat-enviar").click();
  await expect(page.getByTestId("conv-chat:1")).toHaveText("Hola E2E-TEXTO para la lista");
  await expect(page.getByTestId("chat-enviar")).toBeVisible();
  await page.getByTestId("conv-nueva").click();
  await expect(page.getByTestId("conv-chat:2")).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("chat-vacio")).toBeVisible();
  await expect(page.getByTestId("msg-user")).toHaveCount(0);
  await page.getByTestId("conv-chat:1").click();
  await expect(page.getByTestId("msg-user")).toHaveText("Hola E2E-TEXTO para la lista");
});

test("tema: data-theme viene de la preferencia guardada y se aplica al arrancar", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("seo-studio.tema", "light"));
  await page.goto("/#/kb");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(250, 250, 250)");
});

test("tarjeta de job activo en la barra: progreso visible desde cualquier pantalla", async ({ page }) => {
  const s = await settings();
  const job = { id: "j-nav", kind: "transcribe", args: { file: `${s.allowed_dirs[0].path}\\demo.mp4` }, status: "running", progress: 0.3, result: null, error: null, created_at: "2026-10-23T10:00:00Z", updated_at: "2026-10-23T10:00:00Z" };
  const cors = { "access-control-allow-origin": "http://localhost:1420", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
  await page.route("**/jobs", async (route) => {
    const m = route.request().method();
    if (m === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    return route.fulfill({ status: m === "POST" ? 201 : 200, headers: cors, contentType: "application/json", body: JSON.stringify(m === "POST" ? job : [job]) });
  });
  await page.goto("/#/publicar");
  await expect(page.getByTestId("nav-job")).toHaveCount(0);
  await page.getByTestId("publicar-path").fill(`${s.allowed_dirs[0].path}\\demo.mp4`);
  await page.getByTestId("publicar-transcribir").click();
  await page.getByTestId("nav-ajustes").click();
  await expect(page.getByTestId("nav-job")).toContainText("Transcribiendo demo");
  await expect(page.getByTestId("nav-job").getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30");
  job.status = "done";
  job.progress = 1;
  await expect(page.getByTestId("nav-job")).toHaveCount(0, { timeout: 5000 });
  await expect(page.getByRole("status").filter({ hasText: "La transcripción ha terminado" }).first()).toBeVisible();
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
