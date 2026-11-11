/** Guiones en modo Vídeo (docs/pantallas.md → Guiones en modo Vídeo; T15, CA2). Sidecar y motor
 *  reales; el turno del agente se sustituye en el navegador por un SSE con el JSON de cocina, porque
 *  el Anthropic falso no conoce este formato. Lo que se comprueba es lo que hace la UI con la respuesta:
 *  nada se envía sin clic y todo lo del modelo o del servidor se pinta como texto. */
import { expect, test, type Page } from "@playwright/test";
import { api } from "./api";
import { simularRutas } from "./sidecar-falso";
import { crearGuion, GUION_COCINA, leerProyecto, limpiarVideo, listarProyectos, TEXTO_HOSTIL } from "./video-comun";
import type { GuionVideoResumen } from "../src/api/types";

const CORS = { "access-control-allow-origin": "http://localhost:1420", "access-control-allow-headers": "authorization, content-type" };

/** Cada `POST /chat` responde con `texto` como respuesta final del agente. */
async function agenteResponde(page: Page, texto: () => string) {
  await page.route(/127\.0\.0\.1:\d+\/chat$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const ev = [
      { type: "text", delta: texto() },
      { type: "done", conversation_id: "e2e-video", stop_reason: "end_turn", usage: null },
    ];
    await route.fulfill({ status: 200, headers: CORS, contentType: "text/event-stream", body: ev.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") });
  });
}

/** Cuenta los POST a la API de guiones y proyectos de vídeo. */
function contarPost(page: Page) {
  const n = { guiones: 0, proyectos: 0 };
  page.on("request", (r) => {
    if (r.method() !== "POST") return;
    const p = new URL(r.url()).pathname;
    if (p === "/video/guiones") n.guiones++;
    if (p === "/video/proyectos") n.proyectos++;
  });
  return n;
}

async function generar(page: Page, tema = "E2E-VIDEO tortilla") {
  await page.goto("/#/guiones");
  await page.getByTestId("escribir-formato").getByRole("radio", { name: "Vídeo", exact: true }).click();
  await page.getByTestId("escribir-tema").fill(tema);
  await expect(page.getByTestId("escribir-generar")).toBeEnabled();
  await page.getByTestId("escribir-generar").click();
}

test.describe("Guiones en modo Vídeo", () => {
  test.beforeEach(async () => {
    await limpiarVideo();
  });

  test("guion_video_a_editor: del JSON de cocina al editor (CA2)", async ({ page }) => {
    await agenteResponde(page, () => "```json\n" + JSON.stringify(GUION_COCINA) + "\n```");
    await generar(page);

    await expect(page.getByTestId("escribir-video-nota")).toContainText("gasta cuota de YouTube");
    await expect(page.getByTestId("guion-video")).toBeVisible();
    await expect(page.getByTestId("guion-video-titulo")).toHaveValue("Tortilla perfecta");
    await expect(page.getByTestId("guion-video-gancho")).toHaveValue("No batas más los huevos");
    const escenas = page.getByTestId("guion-video-escena");
    await expect(escenas).toHaveCount(3);
    await expect(escenas.nth(1).getByTestId("guion-video-recurso")).toContainText("Tres huevos sobre la encimera");

    // Edita una frase y baja la segunda escena.
    await escenas.nth(2).getByTestId("guion-video-frase").fill("Y a comer.");
    await escenas.nth(1).getByTestId("guion-video-bajar").click();
    await expect(escenas.nth(2).getByTestId("guion-video-recurso")).toBeVisible();

    await page.getByTestId("guion-video-crear").click();
    await expect(page).toHaveURL(/#\/video\/[^/]+$/);
    const id = page.url().split("/").pop()!;
    const p = await leerProyecto(id);
    expect(p.escenas).toHaveLength(3);
    const texto = new Map(p.frases.map((f) => [f.id, f.texto]));
    const frases = p.escenas.flatMap((e) => e.fraseIds.map((id) => texto.get(id) ?? ""));
    expect(frases).toContain("Y a comer.");
    expect(frases.indexOf("Con tres huevos basta.")).toBeGreaterThan(frases.indexOf("Y a comer."));
    expect(await listarProyectos()).toHaveLength(1);
  });

  test("guardar_borrador_sin_proyecto: guardar no crea ningún proyecto", async ({ page }) => {
    await agenteResponde(page, () => JSON.stringify(GUION_COCINA));
    await generar(page);
    await page.getByTestId("guion-video-guardar").click();

    await expect(page.getByTestId("guion-video-guardar")).toHaveText("Guardado");
    const guardados = await api<GuionVideoResumen[]>("/video/guiones");
    expect(guardados).toHaveLength(1);
    expect(await listarProyectos()).toHaveLength(0);
    await expect(page).toHaveURL(/#\/guiones$/);

    const fila = page.getByTestId(`guion-guardado-${guardados[0].id}`);
    await expect(page.getByTestId("guiones-guardados")).toBeVisible();
    await expect(fila).toContainText("Tortilla perfecta");
    await page.getByTestId(`guion-guardado-borrar-${guardados[0].id}`).click();
    await page.getByRole("button", { name: "Cancelar" }).click();
    await expect(fila).toHaveCount(1);
    expect(await api<GuionVideoResumen[]>("/video/guiones")).toHaveLength(1);
    await page.getByTestId(`guion-guardado-borrar-${guardados[0].id}`).click();
    await page.getByRole("dialog").getByRole("button", { name: "Borrar" }).click();
    await expect(fila).toHaveCount(0);
    expect(await api<GuionVideoResumen[]>("/video/guiones")).toHaveLength(0);
  });

  test("sin_llamada_sin_clic: terminar el turno no guarda ni crea nada", async ({ page }) => {
    const n = contarPost(page);
    await agenteResponde(page, () => JSON.stringify(GUION_COCINA));
    await generar(page);
    await expect(page.getByTestId("guion-video")).toBeVisible();
    await page.waitForTimeout(500);
    expect(n).toEqual({ guiones: 0, proyectos: 0 });
    expect(await api<GuionVideoResumen[]>("/video/guiones")).toHaveLength(0);
  });

  test("html_del_modelo_es_texto: el HTML del modelo no crea nodos", async ({ page }) => {
    page.on("dialog", (d) => {
      throw new Error(`alert inesperado: ${d.message()}`);
    });
    const hostil = { ...GUION_COCINA, titulo: TEXTO_HOSTIL, gancho: TEXTO_HOSTIL, escenas: [{ frases: [TEXTO_HOSTIL], base: { tipo: "cartel", texto: "A" }, recurso: { tipo: "foto", que_debe_salir: TEXTO_HOSTIL, resolucion_minima: { ancho: 1080, alto: 1920 } } }] };
    await agenteResponde(page, () => JSON.stringify(hostil));
    await generar(page);
    await expect(page.getByTestId("guion-video-titulo")).toHaveValue(TEXTO_HOSTIL);
    await expect(page.getByTestId("guion-video-frase")).toHaveValue(TEXTO_HOSTIL);
    await expect(page.getByTestId("guion-video-recurso")).toContainText(TEXTO_HOSTIL);
    await expect(page.locator("main img, [data-testid=guion-video] img")).toHaveCount(0);
  });

  test("json_invalido_no_pisa: una respuesta ilegible conserva el guion", async ({ page }) => {
    let turno = 0;
    await agenteResponde(page, () => (turno++ === 0 ? JSON.stringify(GUION_COCINA) : "Hoy no me sale el JSON."));
    await generar(page);
    await expect(page.getByTestId("guion-video-titulo")).toHaveValue("Tortilla perfecta");
    await page.getByTestId("guion-video-titulo").fill("Editado a mano");
    await page.getByTestId("escribir-generar").click();
    await expect(page.getByTestId("guion-json-error")).toBeVisible();
    await expect(page.getByTestId("guion-video-titulo")).toHaveValue("Editado a mano");
  });

  test("errores_servidor_como_texto: el 422 del motor se muestra sin crear proyecto", async ({ page }) => {
    const n = contarPost(page);
    const largo = { ...GUION_COCINA, titulo: "x".repeat(400) };
    await agenteResponde(page, () => JSON.stringify(largo));
    await generar(page);
    await page.getByTestId("guion-video-crear").click();
    const errores = page.getByTestId("guion-video-errores");
    await expect(errores).toBeVisible();
    await expect(errores).toHaveAttribute("role", "alert");
    await expect(errores).not.toBeEmpty();
    await expect(page).toHaveURL(/#\/guiones$/);
    expect(n.proyectos).toBe(0);
    expect(await listarProyectos()).toHaveLength(0);
    // Corrige el título y vuelve a intentarlo: ahora sí.
    await page.getByTestId("guion-video-titulo").fill("Titulo corto");
    await expect(errores).toHaveCount(0);
    await page.getByTestId("guion-video-crear").click();
    await expect(page).toHaveURL(/#\/video\/[^/]+$/);
  });

  test("sin_motor_no_genera: con el motor ausente avisa y no llama al agente", async ({ page }) => {
    let chats = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/chat") chats++;
    });
    await simularRutas(page, { "/video/guiones/esquema": () => [503, { detail: "Módulo de vídeo no instalado" }] });
    await page.goto("/#/guiones");
    await page.getByTestId("escribir-formato").getByRole("radio", { name: "Vídeo", exact: true }).click();
    await page.getByTestId("escribir-tema").fill("tema");
    await expect(page.getByTestId("escribir-video-sin-motor")).toBeVisible();
    await expect(page.getByTestId("escribir-generar")).toBeDisabled();
    expect(chats).toBe(0);
  });

  test("los guiones guardados de antes aparecen al abrir el formato", async ({ page }) => {
    const g = await crearGuion();
    await page.goto("/#/guiones");
    await page.getByTestId("escribir-formato").getByRole("radio", { name: "Vídeo", exact: true }).click();
    await expect(page.getByTestId(`guion-guardado-${g.id}`)).toContainText("Tortilla perfecta");
  });
});
