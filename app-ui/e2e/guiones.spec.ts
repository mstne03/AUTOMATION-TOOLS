/** Guiones (docs/pantallas.md → Guiones). Escribir y Revisar van contra el sidecar real con el
 *  Anthropic falso; Diagnosticar simula /youtube/status, /youtube/channel y /guiones/retencion,
 *  porque en E2E no hay canal autorizado ni datos de Analytics. */
import { expect, test, type Page } from "@playwright/test";
import { GUION, REVISION } from "./anthropic-mock";
import { simularRutas } from "./sidecar-falso";

const RETENCION = {
  video_id: "e2eDiag0001",
  title: "E2E-DIAG Mi vídeo",
  duration_s: 100,
  format: "long",
  intro_window_s: 30,
  intro_retention: 0.42,
  curve: Array.from({ length: 100 }, (_, i) => ({ t: i + 1, ratio: (i + 1) / 100, watch: i < 9 ? 1 : i === 40 ? 0.47 : 0.42, relative: 0.5 })),
  drops: [{ t_start: 9, t_end: 10, from: 1, to: 0.42, delta: -0.58, quote: "Hola a todos y bienvenidos" }],
  spikes: [{ t_start: 40, t_end: 41, from: 0.42, to: 0.47, delta: 0.05, quote: null }],
  transcript_source: "official_api",
  transcript_error: null,
};

const ESTADO_YT = (autorizado: boolean) => ({
  auth: { profile: "default", profiles: ["default"], authenticated: autorizado, store: "FileSecretStore" },
  quota: { buckets: { general: { used: 0, limit: 10000 }, search: { used: 0, limit: 100 }, video_insert: { used: 0, limit: 100 } } },
});

const CANAL = {
  canal: { id: "UC1", titulo: "Canal E2E", handle: "@e2e", avatar: null, suscriptores: 1, visualizaciones_totales: 1, videos: 2 },
  metricas: null,
  metricas_error: null,
  videos: [
    { id: "e2eDiag0001", titulo: "E2E-DIAG Mi vídeo", publicado: "2026-10-20T10:00:00Z", visualizaciones: 10, es_short: false, miniatura: null, estado: "public", programado_para: null },
    { id: "short000001", titulo: "Un Short", publicado: "2026-10-21T10:00:00Z", visualizaciones: 5, es_short: true, miniatura: null, estado: "public", programado_para: null },
  ],
  actualizado: "2026-10-24T11:58:00Z",
  cache: false,
};

const modo = (page: Page, nombre: string) => page.getByTestId("guiones-modos").getByRole("radio", { name: nombre });

test.describe("Guiones", () => {
  test("enlace en la barra lateral y modos: Escribir por defecto y el estado sobrevive a navegar", async ({ page }) => {
    await page.goto("/#/chat");
    await page.getByTestId("nav-guiones").click();
    await expect(page).toHaveURL(/#\/guiones$/);
    await expect(page.getByTestId("nav-guiones")).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Guiones");
    await expect(page.getByTestId("guiones-modos").getByRole("radio")).toHaveText(["Escribir", "Revisar", "Diagnosticar"]);
    await expect(modo(page, "Escribir")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("escribir-form")).toBeVisible();

    await page.getByTestId("escribir-tema").fill("tema a conservar");
    await modo(page, "Revisar").click();
    await expect(page.getByTestId("revisar-guion")).toBeVisible();
    await expect(page.getByTestId("escribir-form")).toHaveCount(0);
    await page.getByTestId("nav-chat").click();
    await page.getByTestId("nav-guiones").click();
    await expect(modo(page, "Revisar")).toHaveAttribute("aria-checked", "true");
    await modo(page, "Escribir").click();
    await expect(page.getByTestId("escribir-tema")).toHaveValue("tema a conservar");
  });

  test("escribir: validación, duración por formato, resultado editable, aviso de duración y copia", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/#/guiones");
    const generar = page.getByTestId("escribir-generar");
    await expect(generar).toBeDisabled();
    await expect(page.getByTestId("escribir-motivo")).toHaveText("Falta el tema.");
    const formato = page.getByTestId("escribir-formato");
    await expect(formato.getByRole("radio", { name: "Vídeo largo" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("escribir-duracion")).toHaveValue("8");
    await formato.getByRole("radio", { name: "Short" }).click();
    await expect(page.getByTestId("escribir-duracion")).toHaveValue("0.5");
    await formato.getByRole("radio", { name: "Vídeo largo" }).click();
    await expect(page.getByTestId("escribir-duracion")).toHaveValue("8");

    await page.getByTestId("escribir-tema").fill("E2E-GUION montar un servidor");
    await expect(page.getByTestId("escribir-motivo")).toHaveCount(0);
    await generar.click();

    const res = page.getByTestId("escribir-resultado");
    await expect(res).toBeVisible();
    await expect(generar).toHaveText("Generar otro");
    const opciones = res.getByTestId("gancho-opcion");
    await expect(opciones).toHaveCount(2);
    await expect(opciones.getByTestId("gancho-tipo")).toHaveText(["promesa", "curiosidad"]);
    await expect(opciones.first().getByRole("radio")).toBeChecked();
    await expect(opciones.nth(1).locator("textarea")).toHaveValue(GUION.ganchos[1].texto);

    const bloques = res.getByTestId("bloque-guion");
    await expect(bloques).toHaveCount(2);
    await expect(bloques.first().getByTestId("bloque-titulo")).toHaveValue("Qué vamos a hacer");
    await expect(bloques.first().getByTestId("bloque-segundos")).toHaveValue("300");
    await expect(bloques.first().getByTestId("bloque-visual")).toHaveValue("plano medio");
    await expect(res.getByTestId("escribir-cta")).toHaveValue(GUION.cta);

    // 300 + 250 = 550 s frente a 480 s objetivo: más de un 10 % → aviso.
    const total = page.getByTestId("escribir-duracion-total");
    await expect(total).toHaveText("9:10 de 8:00 objetivo Te pasas");
    await expect(total).toHaveAttribute("data-nivel", "aviso");
    await bloques.first().getByTestId("bloque-segundos").fill("200");
    await expect(total).toHaveText("7:30 de 8:00 objetivo");
    await expect(total).toHaveAttribute("data-nivel", "ok");

    // Solo se pintan las fuentes https: la http y la javascript: del modelo se descartan.
    const enlaces = page.getByTestId("guion-fuentes").getByRole("link");
    await expect(enlaces).toHaveCount(1);
    await expect(enlaces).toHaveAttribute("href", GUION.fuentes[0].url);

    await opciones.nth(1).getByRole("radio").check();
    await page.getByTestId("escribir-copiar").click();
    await expect(page.getByRole("status").filter({ hasText: "Guion copiado" }).first()).toBeVisible();
    // El portapapeles de Windows guarda los saltos como \r\n.
    const copiado = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
    expect(copiado).toMatch(new RegExp(`^## Gancho\\n\\n${GUION.ganchos[1].texto}\\n\\n## Qué vamos a hacer \\(200s\\)`));
    expect(copiado).toContain("> Visual: plano medio");
    expect(copiado).toContain(`## Llamada a la acción\n\n${GUION.cta}`);
  });

  test("escribir: si la respuesta no es JSON, aviso y el texto del agente a la vista", async ({ page }) => {
    await page.goto("/#/guiones");
    await page.getByTestId("escribir-tema").fill("E2E-ROTO algo");
    await page.getByTestId("escribir-generar").click();
    await expect(page.getByTestId("guion-json-error")).toHaveText("No se pudo leer la respuesta del agente como guion. Abajo tienes su texto completo.");
    await expect(page.getByTestId("escribir-turnos").getByTestId("msg-assistant")).toContainText("hoy no me sale el JSON");
    await expect(page.getByTestId("escribir-resultado")).toHaveCount(0);
  });

  test("revisar: contador y límite, veredicto, gancho reescrito y tabla de problemas", async ({ page }) => {
    await page.goto("/#/guiones");
    await modo(page, "Revisar").click();
    const enviar = page.getByTestId("revisar-enviar");
    const contador = page.getByTestId("field-contador");
    await expect(enviar).toBeDisabled();
    await expect(page.getByTestId("revisar-motivo")).toHaveText("Pega el guion que quieres revisar.");
    await expect(contador).toHaveText("0 / 20000");

    await page.getByTestId("revisar-guion").fill("x".repeat(20_001));
    await expect(contador).toHaveText("20001 / 20000");
    await expect(page.getByTestId("revisar-guion")).toHaveAttribute("aria-invalid", "true");
    await expect(enviar).toBeDisabled();
    await expect(page.getByTestId("revisar-motivo")).toContainText("pasa de 20.000 caracteres");

    await page.getByTestId("revisar-guion").fill("E2E-REVISION Hola a todos, bienvenidos a mi canal.");
    await expect(page.getByTestId("revisar-guion")).not.toHaveAttribute("aria-invalid", "true");
    await enviar.click();

    const res = page.getByTestId("revisar-resultado");
    await expect(res.getByTestId("revisar-veredicto")).toHaveText(REVISION.veredicto_gancho);
    await expect(res.getByTestId("revisar-gancho")).toHaveValue(REVISION.gancho_reescrito);
    const tabla = res.getByTestId("revisar-problemas");
    await expect(tabla.locator("th")).toHaveText(["Fragmento", "Problema", "Propuesta"]);
    await expect(tabla.getByTestId("problema")).toHaveCount(2);
    await expect(tabla.getByTestId("problema").first().locator("td")).toHaveText([REVISION.problemas[0].fragmento, REVISION.problemas[0].problema, REVISION.problemas[0].propuesta]);
  });

  test("diagnosticar: sin canal autorizado se explica y se ofrece autorizarlo", async ({ page }) => {
    await simularRutas(page, { "/youtube/status": ESTADO_YT(false) });
    await page.goto("/#/guiones");
    await modo(page, "Diagnosticar").click();
    await expect(page.getByTestId("diag-motivo")).toHaveText("Autoriza tu canal en Ajustes u Onboarding.");
    await expect(page.getByRole("button", { name: "Autorizar el canal" })).toBeVisible();
    await expect(page.getByTestId("diag-analizar")).toHaveCount(0);
  });

  test("diagnosticar: valida el ID, elige de los últimos vídeos, pinta la curva y propone y guarda con aprobación", async ({ page }) => {
    const llamadas = await simularRutas(page, {
      "/youtube/status": ESTADO_YT(true),
      "/youtube/channel": CANAL,
      "/guiones/retencion": (url) => [200, { ...RETENCION, format: url.searchParams.get("format") }],
    });
    await page.goto("/#/guiones");
    await modo(page, "Diagnosticar").click();
    const analizar = page.getByTestId("diag-analizar");
    await expect(page.getByTestId("diag-nota")).toContainText("100 unidades de cuota");

    await page.getByTestId("diag-video").fill("https://vimeo.com/123");
    await expect(page.getByTestId("diag-video-error")).toHaveText("No es un ID ni una URL de vídeo de YouTube.");
    await expect(analizar).toBeDisabled();
    await page.getByTestId("diag-video").fill("https://www.youtube.com/watch?v=e2eDiag0001&t=3s");
    await expect(page.getByTestId("diag-video-error")).toHaveCount(0);
    await expect(analizar).toBeEnabled();

    // Elegir un Short de la lista rellena el ID y cambia el formato.
    await page.getByTestId("diag-video-short000001").click();
    await expect(page.getByTestId("diag-video")).toHaveValue("short000001");
    await expect(page.getByTestId("diag-formato").getByRole("radio", { name: "Short" })).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("diag-video-e2eDiag0001").click();
    await expect(page.getByTestId("diag-video-e2eDiag0001")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("diag-formato").getByRole("radio", { name: "Vídeo largo" })).toHaveAttribute("aria-checked", "true");
    await analizar.click();

    const res = page.getByTestId("diag-resultado");
    await expect(res).toBeVisible();
    expect(llamadas["/guiones/retencion"]).toBe(1);
    await expect(res.getByTestId("diag-titulo")).toHaveText("E2E-DIAG Mi vídeo · 1:40");
    await expect(res.getByTestId("diag-intro")).toHaveText("42 % sigue viendo a los 30 s Gancho débil");
    await expect(res.getByTestId("diag-intro")).toHaveAttribute("data-nivel", "aviso");
    const curva = res.getByTestId("diag-curva");
    expect(await curva.evaluate((el) => el.tagName.toLowerCase())).toBe("svg");
    expect((await curva.boundingBox())?.height).toBe(200);
    await expect(curva.getByTestId("curva-caida")).toHaveCount(1);
    await expect(curva.getByTestId("curva-pico")).toHaveCount(1);

    const caidas = res.getByTestId("diag-caidas");
    await expect(caidas.locator("th")).toHaveText(["Momento", "Pérdida", "Qué se decía"]);
    await expect(caidas.getByTestId("caida").locator("td")).toHaveText(["0:09–0:10", "−58 pp", "Hola a todos y bienvenidos"]);
    await expect(res.getByTestId("diag-picos").getByTestId("pico").locator("td")).toHaveText(["0:40–0:41", "+5 pp", "—"]);
    await expect(res.getByTestId("diag-sin-transcripcion")).toHaveCount(0);

    const guardar = res.getByTestId("diag-guardar");
    await expect(guardar).toBeDisabled();
    await res.getByTestId("diag-proponer").click();
    const turnos = page.getByTestId("diag-turnos");
    await expect(turnos.getByTestId("msg-assistant").first()).toContainText("En 0:10 se va la gente");
    await expect(guardar).toBeEnabled();

    await guardar.click();
    const card = turnos.getByTestId("approval-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Guardar en tu base privada");
    await card.getByTestId("approval-rechazar").click();
    await expect(turnos.getByTestId("tool-estado")).toHaveText("rechazada");
  });

  test("diagnosticar: error de la tool y vídeo sin transcripción", async ({ page }) => {
    let respuesta: unknown = { error: "YouTube aún no tiene datos de retención de este vídeo." };
    await simularRutas(page, { "/youtube/status": ESTADO_YT(true), "/youtube/channel": CANAL, "/guiones/retencion": () => [200, respuesta] });
    await page.goto("/#/guiones");
    await modo(page, "Diagnosticar").click();
    await page.getByTestId("diag-video").fill("e2eDiag0001");
    await page.getByTestId("diag-analizar").click();
    await expect(page.getByTestId("diag-error")).toHaveText("YouTube aún no tiene datos de retención de este vídeo.");
    await expect(page.getByTestId("diag-resultado")).toHaveCount(0);

    respuesta = { ...RETENCION, drops: RETENCION.drops.map((d) => ({ ...d, quote: null })), transcript_error: "The video has no caption tracks yet" };
    await page.getByTestId("diag-analizar").click();
    await expect(page.getByTestId("diag-error")).toHaveCount(0);
    await expect(page.getByTestId("diag-sin-transcripcion")).toHaveText("Sin transcripción: The video has no caption tracks yet. Los momentos se muestran sin texto.");
    await expect(page.getByTestId("diag-caidas").getByTestId("caida").locator("td").nth(2)).toHaveText("—");
  });

  test("paleta de comandos: «Escribir un guion» abre Guiones en el modo Escribir", async ({ page }) => {
    await page.goto("/#/guiones");
    await modo(page, "Revisar").click();
    await page.getByTestId("nav-paleta").click();
    await page.getByTestId("paleta-input").fill("Escribir un guion");
    await page.keyboard.press("Enter");
    await expect(modo(page, "Escribir")).toHaveAttribute("aria-checked", "true");
  });
});
