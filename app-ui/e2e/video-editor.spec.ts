/** Lista de proyectos y marco del editor (docs/pantallas.md → Vídeo; T16). Sidecar y motor reales;
 *  solo `lista_estados` simula la lista, porque con el motor real todos los proyectos son borrador. */
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
