/** Lista de proyectos y marco del editor (docs/pantallas.md → Vídeo; T16). Sidecar y motor reales;
 *  solo `lista_estados` simula la lista, porque con el motor real todos los proyectos son borrador. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { simularRutas } from "./sidecar-falso";
import {
  irAlEditor,
  leerProyecto,
  limpiarVideo,
  proyectoDeCocina,
  TEXTO_HOSTIL,
} from "./video-comun";
import { api } from "./api";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await limpiarVideo();
});

const resumen = (id: string, estado: string) => ({
  id,
  titulo: `Vídeo ${estado}`,
  perfil: "defecto",
  duracion: 75,
  actualizado: "2026-11-07T10:00:00Z",
  estado,
});

test("lista_estados: los cuatro estados llevan su data-estado", async ({
  page,
}) => {
  await simularRutas(page, {
    "/video/proyectos": [
      resumen("a", "borrador"),
      resumen("b", "renderizando"),
      resumen("c", "listo"),
      resumen("d", "error"),
    ],
  });
  await page.goto("/#/video");
  await expect(page.getByTestId("video-lista")).toBeVisible();
  for (const [id, estado] of [
    ["a", "borrador"],
    ["b", "renderizando"],
    ["c", "listo"],
    ["d", "error"],
  ]) {
    await expect(
      page.getByTestId(`video-proyecto-estado-${id}`),
    ).toHaveAttribute("data-estado", estado);
  }
});

test("lista: vacía, con un proyecto real y borrado con confirmación", async ({
  page,
}) => {
  await page.goto("/#/video");
  await expect(page.getByTestId("video-vacio")).toBeVisible();
  const id = await proyectoDeCocina();
  await page.reload();
  await expect(page.getByTestId(`video-proyecto-${id}`)).toContainText(
    "Tortilla perfecta",
  );
  await page.getByTestId(`video-proyecto-borrar-${id}`).click();
  await page.getByRole("button", { name: "Cancelar" }).click();
  expect((await api<unknown[]>("/video/proyectos")).length).toBe(1);
  await page.getByTestId(`video-proyecto-borrar-${id}`).click();
  await page.getByRole("button", { name: "Borrar", exact: true }).click();
  await expect(page.getByTestId("video-vacio")).toBeVisible();
  expect((await api<unknown[]>("/video/proyectos")).length).toBe(0);
});

test("lista: el título con HTML es texto", async ({ page }) => {
  await simularRutas(page, {
    "/video/proyectos": [{ ...resumen("a", "borrador"), titulo: TEXTO_HOSTIL }],
  });
  await page.goto("/#/video");
  await expect(page.getByTestId("video-proyecto-a")).toContainText(
    TEXTO_HOSTIL,
  );
  await expect(page.getByTestId("video-proyecto-a").locator("img")).toHaveCount(
    0,
  );
});

test("layout_b_900x600: sin scroll horizontal y medidas exactas de las tres zonas", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 });
  const id = await proyectoDeCocina();
  await irAlEditor(page, id);
  await expect(page.getByTestId("editor")).toBeVisible();
  const medir = (tid: string) =>
    page
      .getByTestId(tid)
      .evaluate((e) => ({
        ancho: Math.round(e.getBoundingClientRect().width),
        alto: Math.round(e.getBoundingClientRect().height),
      }));
  expect((await medir("editor-zona-panel")).ancho).toBe(320);
  expect((await medir("editor-zona-timeline")).alto).toBe(240);
  const cabecera = await page
    .getByTestId("editor-titulo")
    .evaluate((e) =>
      Math.round(e.parentElement!.getBoundingClientRect().height),
    );
  expect(cabecera).toBe(48);
  const preview = await medir("editor-zona-preview");
  const editor = await medir("editor");
  expect(preview.ancho).toBe(editor.ancho - 320);
  expect(preview.alto).toBe(editor.alto - 48 - 240);
  const desborda = await page.evaluate(() => {
    const d = document.documentElement;
    const main = document.querySelector("main")!;
    return {
      pagina: d.scrollWidth > d.clientWidth,
      main: main.scrollWidth > main.clientWidth,
      alto: main.scrollHeight > main.clientHeight,
    };
  });
  expect(desborda).toEqual({ pagina: false, main: false, alto: false });
});

test("timeline_900x600: a todo el ancho, Música a la vista o con scroll y píldoras enteras", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 });
  // Con música elegida la fila Música lleva todos sus controles (la más alta).
  await simularRutas(page, { "/video/musica": { pistas: [{ id: "m1", nombre: "Pista de prueba" }] } });
  const id = await proyectoDeCocina();
  await irAlEditor(page, id);
  await page.getByTestId("musica-elegir").selectOption("m1");
  await expect(page.getByTestId("musica-ducking")).toBeAttached();
  const timeline = page.getByTestId("timeline");
  const pildoras = page.getByTestId("pista-voz").locator("[data-tone=write]");
  await expect(pildoras).toHaveCount(4);
  // Evidencia para revisar a ojo (no es una referencia visual).
  await page.screenshot({ path: test.info().outputPath("timeline-900x600.png") });

  const g = await timeline.evaluate((t) => {
    const caja = (e: Element) => e.getBoundingClientRect();
    const zona = caja(document.querySelector("[data-testid=editor-zona-timeline]")!);
    const tl = caja(t);
    const derechaUtil = tl.left + t.clientLeft + t.clientWidth;
    const filas = ["timeline-regla", "pista-escenas", "pista-recursos", "pista-voz", "pista-musica", "pista-subtitulos"].map(
      (tid) => caja(t.querySelector(`[data-testid=${tid}]`)!).right,
    );
    return {
      viewport: innerWidth,
      zona: { left: zona.left, right: zona.right, top: zona.top, bottom: zona.bottom },
      tl: { left: tl.left, right: tl.right, top: tl.top, bottom: tl.bottom },
      derechaUtil,
      filas,
      scrollH: t.scrollHeight,
      clientH: t.clientHeight,
      scrollW: t.scrollWidth,
      clientW: t.clientWidth,
      pulgar: getComputedStyle(t).scrollbarColor,
    };
  });
  // 1. El timeline ocupa toda su zona y cada fila llega a su borde derecho útil.
  expect(g.zona.right).toBeLessThanOrEqual(g.viewport);
  expect(Math.round(g.tl.left)).toBe(Math.round(g.zona.left));
  expect(Math.round(g.tl.right)).toBe(Math.round(g.zona.right));
  for (const derecha of g.filas) expect(Math.round(derecha)).toBe(Math.round(g.derechaUtil));
  expect(g.scrollW).toBeLessThanOrEqual(g.clientW);

  // 2. La fila Música empieza dentro del área visible; si no cabe entera, el timeline se desplaza en
  //    vertical con la barra visible en reposo (no transparente) y al desplazarse queda entera a la vista.
  const musica = page.getByTestId("pista-musica");
  const filaMusica = await musica.evaluate((e) => {
    const r = e.parentElement!.parentElement!.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  expect(filaMusica.top).toBeGreaterThanOrEqual(g.tl.top);
  expect(filaMusica.top + 24).toBeLessThanOrEqual(g.tl.bottom);
  await expect(page.getByTestId("musica-elegir")).toBeInViewport();
  if (filaMusica.bottom > g.tl.bottom) {
    expect(g.scrollH).toBeGreaterThan(g.clientH);
    expect(g.pulgar.startsWith("transparent")).toBe(false);
    await page.getByTestId("musica-ducking").scrollIntoViewIfNeeded();
    const tras = await musica.evaluate((e, tl) => {
      const r = e.parentElement!.parentElement!.getBoundingClientRect();
      return r.top >= tl.top - 0.5 && r.bottom <= tl.bottom + 0.5;
    }, g.tl);
    expect(tras).toBe(true);
  }

  // 3. Ninguna píldora «Pendiente» se recorta: su contenido cabe y su caja cae dentro de la del clip.
  for (const p of await pildoras.all()) {
    const r = await p.evaluate((e) => {
      const chip = e.getBoundingClientRect();
      const clip = e.closest("[data-testid^=clip-voz-]")!.getBoundingClientRect();
      return {
        cabe: e.scrollWidth <= e.clientWidth && e.scrollHeight <= e.clientHeight,
        dentro: chip.left >= clip.left - 0.5 && chip.right <= clip.right + 0.5 && chip.width > 0,
      };
    });
    expect(r).toEqual({ cabe: true, dentro: true });
  }
});

test("editor: título como texto y volver a la lista", async ({ page }) => {
  const id = await proyectoDeCocina();
  const p = await leerProyecto(id);
  await api(`/video/proyectos/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      revision: p.revision,
      proyecto: { ...p, titulo: TEXTO_HOSTIL },
    }),
  });
  await irAlEditor(page, id);
  await expect(page.getByTestId("editor-titulo")).toHaveText(TEXTO_HOSTIL);
  await expect(page.getByTestId("editor-titulo").locator("img")).toHaveCount(0);
  await expect(page.getByTestId("editor-guardado")).toHaveText("Guardado");
  await page.getByTestId("editor-volver").click();
  await expect(page).toHaveURL(/#\/video$/);
});

test("editor-error: un proyecto inexistente avisa", async ({ page }) => {
  await irAlEditor(page, "noexiste00");
  await expect(page.getByTestId("editor-error")).toBeVisible();
});

test("editor-conflicto: un 409 recarga lo del servidor y la edición local se recupera", async ({
  page,
}) => {
  const id = await proyectoDeCocina();
  await irAlEditor(page, id);
  await expect(page.getByTestId("editor")).toBeVisible();
  // «Otra pestaña» guarda primero, por la API.
  const p = await leerProyecto(id);
  await api(`/video/proyectos/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      revision: p.revision,
      proyecto: { ...p, titulo: "Remoto" },
    }),
  });
  // Sin panel todavía (T18): la edición local entra por el módulo del store que sirve Vite (misma instancia que la app).
  await page.evaluate(async () => {
    const ruta = "/src/state/editor.ts";
    const { editar } = (await import(/* @vite-ignore */ ruta)) as {
      editar: (fn: (p: { titulo: string }) => void) => void;
    };
    editar((x) => void (x.titulo = "Local"));
  });
  await expect(page.getByTestId("editor-conflicto")).toBeVisible(); // el autoguardado (800 ms) choca con la revisión nueva
  await expect(page.getByTestId("editor-titulo")).toHaveText("Remoto");
  await page.getByRole("button", { name: "Recuperar mi edición" }).click();
  await expect(page.getByTestId("editor-conflicto")).toHaveCount(0);
  await expect(page.getByTestId("editor-titulo")).toHaveText("Local");
  await expect(page.getByTestId("editor-guardado")).toHaveText("Guardado");
  expect((await leerProyecto(id)).titulo).toBe("Local");
});

test("recursos: añadir una foto no abre un conflicto falso y se asigna a la escena", async ({ page }) => {
  const id = await proyectoDeCocina();
  // Lo que haría el diálogo nativo (T13): copia el fichero a la bandeja y devuelve solo su id.
  const bandeja = randomBytes(16).toString("hex");
  const dir = join(process.env.E2E_STATE_DIR!, "video", "bandeja");
  mkdirSync(dir, { recursive: true });
  const png = join(dir, `${bandeja}.png`);
  execFileSync(join(process.env.E2E_FFMPEG!, "ffmpeg"), ["-v", "error", "-f", "lavfi", "-i", "color=c=0x336699:s=1080x1920", "-frames:v", "1", png]);
  renameSync(png, join(dir, `${bandeja}.bin`));
  await page.addInitScript(
    ({ port, token, bandeja }) => {
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string) => (cmd === "sidecar_info" ? { port, token } : cmd === "importar_recurso" ? bandeja : null),
        transformCallback: () => 0,
      };
    },
    { port: Number(new URL(process.env.E2E_SIDECAR!).port), token: process.env.E2E_TOKEN!, bandeja },
  );
  await irAlEditor(page, id);
  await expect(page.getByTestId("editor")).toBeVisible();
  await page.getByRole("radio", { name: "Recursos" }).click();
  await page.getByTestId("recursos-anadir-foto").click();
  await expect(page.getByTestId("recursos-lista").locator("li")).toHaveCount(1);
  await expect(page.getByTestId("recursos-error")).toHaveCount(0);
  const rid = (await leerProyecto(id)).recursos[0].id;

  // Asignarla: «Ver escena» lleva a la pestaña Escena; el selector crea la capa y el guardado no choca.
  const escena = (await leerProyecto(id)).escenas[0].id;
  await page.getByTestId(`clip-escena-${escena}`).click();
  await page.getByRole("radio", { name: "Escena" }).click();
  await page.getByTestId("escena-capa-recurso").selectOption(rid);
  await expect(page.getByTestId("editor-guardado")).toHaveText("Guardado");
  await expect(page.getByTestId("editor-conflicto")).toHaveCount(0);
  await expect(page.getByTestId(`clip-recurso-${escena}`)).toBeVisible();
  const capa = (await leerProyecto(id)).escenas[0].capa;
  expect(capa).toMatchObject({ recursoId: rid, modo: "encima", encuadre: "marco", entrada: 0 });
});
