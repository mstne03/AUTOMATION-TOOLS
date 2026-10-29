/** Base de conocimiento rediseñada: estado del snapshot, resultados como tarjetas con filtro de
 *  origen, fuentes y "Mi base privada". Sidecar real; lo que tocaría la red (actualizar el snapshot,
 *  ingerir una URL) se simula. */
import { expect, test } from "@playwright/test";
import { api } from "./api";
import { simularRutas } from "./sidecar-falso";

interface Tarjeta {
  titulo: string;
  origen: string;
  url: string | null;
}

test.describe("Base de conocimiento", () => {
  test("estado del snapshot y texto detallado del sidecar", async ({ page }) => {
    const estado = await api<{ texto: string; snapshot: { version: string | null; documentos: number | null; instalada: boolean } }>("/kb/estado");
    await page.goto("/#/kb");
    const snap = page.getByTestId("kb-snapshot");
    await expect(snap.getByText("Versión")).toBeVisible({ timeout: 30_000 });
    if (estado.snapshot.instalada) await expect(snap).toContainText("Verificada al instalar");
    if (estado.snapshot.version) await expect(snap).toContainText(estado.snapshot.version);
    await expect(page.getByTestId("kb-estado")).toHaveText(estado.texto);
  });

  test("buscar: tarjetas con título, plataforma, origen y fragmento; el filtro de origen las oculta", async ({ page }) => {
    await page.goto("/#/kb");
    const select = page.getByTestId("kb-plataforma");
    expect(await select.locator("option").allTextContents()).toEqual(["todas", "youtube", "tiktok", "instagram", "linkedin", "x"]);
    await expect(page.getByTestId("kb-buscar-btn")).toBeDisabled();
    await page.getByTestId("kb-q").fill("hashtags");
    await select.selectOption("tiktok");
    const [req] = await Promise.all([page.waitForRequest((r) => r.url().includes("/kb/buscar")), page.getByTestId("kb-buscar-btn").click()]);
    const url = new URL(req.url());
    expect(url.searchParams.get("q")).toBe("hashtags");
    expect(url.searchParams.get("plataforma")).toBe("tiktok");
    expect(url.searchParams.get("formato")).toBe("json");
    expect(url.searchParams.get("k")).toBe("8");

    const esperado = await api<Tarjeta[]>("/kb/buscar?q=hashtags&plataforma=tiktok&k=8&formato=json");
    await expect(page.getByTestId("kb-resultado")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("kb-tarjeta")).toHaveCount(esperado.length);
    if (esperado.length > 0) {
      const primera = page.getByTestId("kb-tarjeta").first();
      await expect(primera).toContainText(esperado[0].titulo);
      await expect(primera).toContainText(esperado[0].origen === "privada" ? "KB privada" : "Pública");
      await expect(primera).toContainText("tiktok");
      await expect(primera.locator("p")).not.toBeEmpty();
      // sin la cabecera interna "[título | plataforma | fecha]" que la ingesta graba en los chunks ("[…]" es el recorte)
      expect(await page.getByTestId("kb-resultado").textContent()).not.toMatch(/\[[^\]]*\|[^\]]*\]/);
    }
    // filtro por origen (en cliente): sin documentos privados no queda nada
    const privados = esperado.filter((t) => t.origen === "privada").length;
    await page.getByTestId("kb-origen").getByRole("radio", { name: "KB privada" }).click();
    await expect(page.getByTestId("kb-tarjeta")).toHaveCount(privados);
    await page.getByTestId("kb-origen").getByRole("radio", { name: "Todos" }).click();
    await expect(page.getByTestId("kb-tarjeta")).toHaveCount(esperado.length);
  });

  test("fuentes: lista estructurada con el mismo número de documentos que el sidecar", async ({ page }) => {
    await page.goto("/#/kb");
    await page.getByTestId("kb-plataforma").selectOption("tiktok");
    const esperado = await api<Tarjeta[]>("/kb/fuentes?plataforma=tiktok&formato=json");
    await page.getByTestId("kb-fuentes").click();
    await expect(page.getByTestId("kb-fuentes-lista")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("kb-fuente")).toHaveCount(esperado.length);
    await expect(page.getByTestId("kb-fuentes-lista")).toContainText(`${esperado.length} ${esperado.length === 1 ? "fuente" : "fuentes"}`);
  });

  test("buscar actualización: avisa del resultado con un toast", async ({ page }) => {
    await simularRutas(page, { "/kb/update": { accion: "sin_cambios", version: "2026-10-23" } });
    await page.goto("/#/kb");
    await page.getByTestId("kb-actualizar").click();
    await expect(page.getByRole("status").filter({ hasText: "Ya tienes la última versión" }).first()).toBeVisible();
  });

  test("mi base privada: una nota guardada se lista y se borra con confirmación (sidecar real)", async ({ page }) => {
    await api("/kb/privada/notas", {
      method: "POST",
      body: JSON.stringify({ identificador: "e2e:nota-ui", titulo: "Nota de prueba E2E", texto: "Los shorts con gancho retienen más.", platforms: ["youtube"], published_at: "2026-10-11" }),
    });
    await page.goto("/#/kb");
    const item = page.getByTestId("kb-privada-item").filter({ hasText: "Nota de prueba E2E" });
    await expect(item).toBeVisible({ timeout: 30_000 });
    await expect(item).toContainText("KB privada");
    await item.getByTestId("kb-privada-borrar").click();
    const dialogo = page.getByRole("dialog", { name: "¿Quitar de tu base privada?" });
    await expect(dialogo).toContainText("e2e:nota-ui");
    await dialogo.getByRole("button", { name: "Cancelar" }).click();
    await expect(item).toBeVisible();
    await item.getByTestId("kb-privada-borrar").click();
    await page.getByRole("dialog").getByRole("button", { name: "Quitar" }).click();
    await expect(item).toHaveCount(0);
    const quedan = await api<Array<{ url: string }>>("/kb/privada/fuentes");
    expect(quedan.some((f) => f.url === "e2e:nota-ui")).toBe(false);
  });

  test("mi base privada: estado vacío, alta por URL con validación y aviso (ingesta simulada)", async ({ page }) => {
    let docs: Array<{ title: string; url: string; published_at: string | null; platforms: string[] }> = [];
    const altas: unknown[] = [];
    await simularRutas(page, {
      "/kb/privada/fuentes": (_u, p) => {
        if (p.metodo === "POST") {
          altas.push(p.cuerpo);
          const url = (p.cuerpo as { url: string }).url;
          docs = [{ title: "Artículo añadido", url, published_at: null, platforms: ["general"] }];
          return [201, { url, chunks: 4, skipped: false }];
        }
        return [200, docs];
      },
    });
    await page.goto("/#/kb");
    await expect(page.getByTestId("kb-privada").getByText("Tu base privada está vacía")).toBeVisible();
    await page.getByTestId("kb-privada").getByRole("button", { name: "Añadir URL" }).click();
    await expect(page.getByTestId("kb-privada-url")).toBeFocused();
    await expect(page.getByTestId("kb-privada-add")).toBeDisabled();
    await page.getByTestId("kb-privada-url").fill("no es una url");
    await expect(page.getByText("Escribe una URL que empiece por http:// o https://")).toBeVisible();
    await expect(page.getByTestId("kb-privada-add")).toBeDisabled();
    await page.getByTestId("kb-privada-url").fill("https://ejemplo.com/articulo");
    await page.getByTestId("kb-privada-add").click();
    await expect(page.getByRole("status").filter({ hasText: "Añadida a tu base privada" }).first()).toBeVisible();
    expect(altas).toEqual([{ url: "https://ejemplo.com/articulo" }]);
    await expect(page.getByTestId("kb-privada-item")).toHaveCount(1);
    await expect(page.getByTestId("kb-privada-item")).toContainText("Artículo añadido");
    await expect(page.getByTestId("kb-privada-url")).toHaveValue("");
  });
});
