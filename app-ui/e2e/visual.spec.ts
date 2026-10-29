/** Regresión visual (DS-12): cada pantalla y el catálogo, en claro y oscuro, a 1200×800 y 900×600.
 *  Sidecar real para el shell y datos simulados para lo que varía (ajustes, canal, KB), con el reloj
 *  fijo, para que las capturas sean estables. Las referencias van en e2e/__capturas__ (sin sufijo de
 *  plataforma: se generan en Windows, la máquina de Marc). Regenerarlas tras un cambio de diseño
 *  intencionado: `pnpm e2e visual --update-snapshots`. */
import { expect, test, type Page } from "@playwright/test";
import { simularRutas } from "./sidecar-falso";

const AHORA = new Date("2026-10-24T12:00:00Z");

const AJUSTES = {
  model: "claude-opus-5-5",
  models: ["claude-opus-5-5", "claude-sonnet-5-5"],
  allowed_dirs: [{ path: "C:\\Videos", language: "es" }],
  profile: "default",
  has_anthropic_key: true,
  has_client_secret: true,
  google_project: { project_id: "demo-seo-studio", client_id: "123456…wxyz" },
  state_dir: "C:\\Users\\demo\\AppData\\Roaming\\SEO Studio",
  secret_store: "FileSecretStore",
  hf_hub_offline: null,
};

const ESTADO_YT = {
  auth: { profile: "default", profiles: ["default"], authenticated: true, store: "FileSecretStore" },
  quota: { buckets: { general: { used: 2500, limit: 10000 }, search: { used: 12, limit: 100 }, video_insert: { used: 3, limit: 100 } } },
};

const CANAL = {
  canal: { id: "UC1", titulo: "Canal de demostración", handle: "@demo", avatar: null, suscriptores: 1234, visualizaciones_totales: 56789, videos: 12 },
  metricas: { inicio: "2026-09-25", fin: "2026-10-23", visualizaciones: 4321, visualizaciones_delta_pct: 12.5, horas_vistas: 98.7, suscriptores_netos: 15, retencion_media: 41.2 },
  metricas_error: null,
  videos: [
    { id: "pub0000001", titulo: "Cómo posicionar un vídeo", publicado: "2026-10-20T10:00:00Z", visualizaciones: 12345, es_short: true, miniatura: null, estado: "public", programado_para: null },
    { id: "priv000002", titulo: "Borrador sin publicar", publicado: "2026-10-22T10:00:00Z", visualizaciones: 0, es_short: false, miniatura: null, estado: "private", programado_para: null },
    { id: "prog000003", titulo: "Estreno programado", publicado: "2026-10-23T10:00:00Z", visualizaciones: 0, es_short: false, miniatura: null, estado: "private", programado_para: "2026-10-30T18:00:00Z" },
  ],
  actualizado: "2026-10-24T11:58:00Z",
  cache: false,
};

const KB_ESTADO = {
  texto: "Snapshot 2026-10-23: 120 documentos, 3400 fragmentos.",
  snapshot: { instalada: true, version: "2026-10-23", exportada: "2026-10-23T03:00:00Z", documentos: 120, chunks: 3400, anterior_disponible: false, url: "https://example.invalid/kb", ultima_comprobacion: "2026-10-24T11:00:00Z", ultimo_error: null },
};

const PANTALLAS: Array<{ nombre: string; ruta: string; listo: (p: Page) => Promise<void> }> = [
  { nombre: "chat", ruta: "/#/chat", listo: async (p) => void (await p.getByTestId("chat-input").waitFor()) },
  { nombre: "publicar", ruta: "/#/publicar", listo: async (p) => void (await p.getByTestId("publicar-pasos").waitFor()) },
  { nombre: "guiones", ruta: "/#/guiones", listo: async (p) => void (await p.getByTestId("escribir-form").waitFor()) },
  { nombre: "canal", ruta: "/#/canal", listo: async (p) => void (await p.getByTestId("canal-videos").waitFor()) },
  { nombre: "kb", ruta: "/#/kb", listo: async (p) => void (await p.getByTestId("kb-snapshot").getByText("Versión").waitFor()) },
  { nombre: "ajustes", ruta: "/#/ajustes", listo: async (p) => void (await p.getByTestId("ajustes-nav-general").waitFor()) },
  { nombre: "onboarding", ruta: "/#/onboarding", listo: async (p) => void (await p.getByTestId("onboarding-pasos").waitFor({ state: "attached" })) },
  { nombre: "catalogo", ruta: "/#/catalogo", listo: async (p) => void (await p.getByRole("heading", { name: "Catálogo de componentes" }).waitFor()) },
];

const TAMANOS = [
  { ancho: 1200, alto: 800 },
  { ancho: 900, alto: 600 },
];

for (const tema of ["dark", "light"] as const) {
  for (const t of TAMANOS) {
    test.describe(`Capturas ${tema} ${t.ancho}x${t.alto}`, () => {
      test.use({ viewport: { width: t.ancho, height: t.alto }, colorScheme: tema });

      for (const pantalla of PANTALLAS) {
        // el catálogo ya muestra los dos temas a la vez: una sola captura por tamaño
        if (pantalla.nombre === "catalogo" && tema === "light") continue;
        test(pantalla.nombre, async ({ page }) => {
          await page.clock.install({ time: AHORA });
          await page.addInitScript((v) => localStorage.setItem("seo-studio.tema", v), tema);
          await simularRutas(page, {
            "/settings": AJUSTES,
            "/youtube/status": ESTADO_YT,
            "/youtube/channel": CANAL,
            "/kb/estado": KB_ESTADO,
            "/kb/privada/fuentes": [],
            "/conversations": [],
          });
          await page.goto(pantalla.ruta);
          await pantalla.listo(page);
          await page.evaluate(() => document.fonts.ready);
          await expect(page).toHaveScreenshot(`${pantalla.nombre}-${tema}-${t.ancho}x${t.alto}.png`, { fullPage: false, maxDiffPixelRatio: 0.002 });
        });
      }
    });
  }
}
