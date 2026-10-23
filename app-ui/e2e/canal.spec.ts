/** Panel de canal rediseñado (artboard "Panel de canal (oscuro)"). El sidecar de los E2E no tiene
 *  OAuth real, así que /youtube/status y /youtube/channel se simulan; el contrato de GET
 *  /youtube/channel lo prueba app-backend/tests/test_canal.py. */
import { expect, test } from "@playwright/test";
import { simularRutas } from "./sidecar-falso";

const STATUS = {
  auth: { profile: "default", profiles: ["default"], authenticated: true, store: "FileSecretStore" },
  quota: {
    buckets: {
      general: { used: 8500, limit: 10000 },
      search: { used: 3, limit: 100 },
      video_insert: { used: 99, limit: 100 },
    },
  },
};

const PANEL = {
  canal: { id: "UC1", titulo: "Marc Serra", handle: "@mserra03", avatar: null, suscriptores: 1234, visualizaciones_totales: 56789, videos: 12 },
  metricas: { inicio: "2026-09-25", fin: "2026-10-23", visualizaciones: 4321, visualizaciones_delta_pct: 12.5, horas_vistas: 98.7, suscriptores_netos: 15, retencion_media: 41.2 },
  metricas_error: null,
  videos: [
    { id: "pub0000001", titulo: "Vídeo público", publicado: "2026-10-20T10:00:00Z", visualizaciones: 12345, es_short: true, miniatura: null, estado: "public", programado_para: null },
    { id: "priv000002", titulo: "Vídeo privado", publicado: "2026-10-22T10:00:00Z", visualizaciones: 0, es_short: false, miniatura: null, estado: "private", programado_para: null },
    { id: "prog000003", titulo: "Vídeo programado", publicado: "2026-10-23T10:00:00Z", visualizaciones: 0, es_short: false, miniatura: null, estado: "private", programado_para: "2026-10-30T18:00:00Z" },
  ],
  actualizado: new Date().toISOString(),
  cache: false,
};

test.describe("Panel de canal rediseñado", () => {
  test("identidad, métricas, últimos vídeos y cuota legible", async ({ page }) => {
    const llamadas = await simularRutas(page, { "/youtube/status": STATUS, "/youtube/channel": PANEL });
    await page.goto("/#/canal");
    const cab = page.getByTestId("canal-estado");
    await expect(cab.getByRole("heading", { level: 1 })).toHaveText("@mserra03");
    await expect(cab).toContainText("Perfil default");
    await expect(cab).toContainText("datos de hace");
    await expect(cab.getByText("Autorizado")).toBeVisible();

    await expect(page.getByTestId("canal-metrica-suscriptores")).toContainText("1.234");
    await expect(page.getByTestId("canal-metrica-suscriptores")).toContainText("+15 en 28 días");
    await expect(page.getByTestId("canal-metrica-visualizaciones")).toContainText("4.321");
    await expect(page.getByTestId("canal-metrica-visualizaciones")).toContainText("+12,5 % vs 28 d previos");
    await expect(page.getByTestId("canal-metrica-horas")).toContainText("98,7");
    await expect(page.getByTestId("canal-metrica-retencion")).toContainText("41,2 %");

    const tabla = page.getByTestId("canal-videos");
    await expect(tabla.locator("tbody tr")).toHaveCount(3);
    const pub = page.getByTestId("canal-video-pub0000001");
    await expect(pub).toContainText("Vídeo público");
    await expect(pub).toContainText("Short");
    await expect(pub).toContainText("Público");
    await expect(pub).toContainText("12.345");
    await expect(page.getByTestId("canal-video-priv000002")).toContainText("Privado");
    await expect(page.getByTestId("canal-video-prog000003")).toContainText("Programado");
    await expect(page.getByTestId("canal-video-accion-pub0000001")).toHaveText("Analizar");
    await expect(page.getByTestId("canal-video-accion-priv000002")).toHaveText("Editar");

    // cuota con nombres legibles, separador de miles y hora local de reinicio; color al acercarse al límite
    const cuota = page.getByTestId("canal-cuota");
    await expect(cuota).toContainText(/se reinicia a las \d{2}:\d{2}/);
    await expect(page.getByTestId("cuota-general")).toContainText("Unidades");
    await expect(page.getByTestId("cuota-general")).toContainText("8.500 de 10.000");
    await expect(page.getByTestId("cuota-search")).toContainText("Búsquedas");
    await expect(page.getByTestId("cuota-video_insert")).toContainText("Subidas");
    await expect(page.getByTestId("cuota-video_insert")).toContainText("99 de 100");
    await expect(page.getByTestId("cuota-search")).toHaveAttribute("data-nivel", "normal");
    await expect(page.getByTestId("cuota-general")).toHaveAttribute("data-nivel", "alto");
    await expect(page.getByTestId("cuota-video_insert")).toHaveAttribute("data-nivel", "critico");
    expect(llamadas["/youtube/channel"]).toBe(1);
  });

  test("acciones: analizar el canal, un vídeo, editar y preguntas sugeridas abren el chat con ese mensaje", async ({ page }) => {
    await simularRutas(page, { "/youtube/status": STATUS, "/youtube/channel": PANEL });
    const enChat = async (texto: RegExp) => {
      await expect(page).toHaveURL(/#\/chat$/);
      await expect(page.getByTestId("msg-user").last()).toContainText(texto);
      await expect(page.getByTestId("chat-enviar")).toBeVisible(); // el turno acaba antes de seguir (un turno a la vez)
      await page.getByTestId("nav-canal").click();
    };
    await page.goto("/#/canal");
    await expect(page.getByTestId("canal-video-accion-pub0000001")).toBeVisible();
    await page.getByTestId("canal-pregunta").click();
    await enChat(/Analiza mi canal/);
    await page.getByTestId("canal-video-accion-pub0000001").click();
    await enChat(/Analiza el vídeo pub0000001 \(«Vídeo público»\)/);
    await page.getByTestId("canal-video-accion-priv000002").click();
    await enChat(/editar los metadatos del vídeo priv000002/);
    await page.getByTestId("canal-sugerencia-2").click();
    await enChat(/Propón 3 títulos para el próximo Short/);
  });

  test("si Analytics no está disponible, el resto del panel se ve y avisa en las métricas", async ({ page }) => {
    await simularRutas(page, { "/youtube/status": STATUS, "/youtube/channel": { ...PANEL, metricas: null, metricas_error: "Analytics API has not been used" } });
    await page.goto("/#/canal");
    await expect(page.getByTestId("canal-metrica-suscriptores")).toContainText("1.234");
    await expect(page.getByTestId("canal-metrica-visualizaciones")).toContainText("—");
    await expect(page.getByTestId("canal-metrica-visualizaciones")).toContainText("Analytics no disponible");
    await expect(page.getByTestId("canal-videos").locator("tbody tr")).toHaveCount(3);
  });

  test("sin autorizar: sin consultas al canal, estado vacío y acciones deshabilitadas", async ({ page }) => {
    const llamadas = await simularRutas(page, { "/youtube/status": { ...STATUS, auth: { ...STATUS.auth, authenticated: false } } });
    await page.goto("/#/canal");
    await expect(page.getByTestId("canal-estado").getByText("Sin autorizar")).toBeVisible();
    await expect(page.getByText("El canal no está autorizado")).toBeVisible();
    await expect(page.getByTestId("canal-pregunta")).toBeDisabled();
    await expect(page.getByTestId("canal-sugerencia-1")).toBeDisabled();
    expect(llamadas["/youtube/channel"]).toBeUndefined();
  });

  test("un error del sidecar al leer el canal se muestra en claro", async ({ page }) => {
    await simularRutas(page, { "/youtube/status": STATUS, "/youtube/channel": () => [502, { detail: "No se pudo leer el canal: Channel not found" }] });
    await page.goto("/#/canal");
    await expect(page.getByTestId("canal-error")).toContainText("Channel not found");
  });
});
