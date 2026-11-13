/** Ajustes › Motor de vídeo (docs/pantallas.md): descarga del navegador del render y modo de render.
 *  Ajustes y el resto del sidecar son reales; las tres rutas de vídeo se simulan SIEMPRE.
 *
 *  Seguridad: el sidecar de los E2E no está congelado y `POST /video/navegador/descarga` bajaría 120 MB
 *  de verdad. `simularRutas` hace `route.continue()` con lo que no conoce, así que un bloqueo previo no
 *  serviría: aquí esa ruta (y las otras dos) están siempre en `rutas`, con un error por defecto que
 *  además anota la petición. Cada test falla si salió un POST sin simular o si el sidecar real cambió. */
import { expect, test, type Page } from "@playwright/test";
import { api } from "./api";
import type { Settings } from "../src/api/types";
import { simularRutas } from "./sidecar-falso";

const MiB = 1024 * 1024;
type Fase = "ausente" | "descargando" | "verificando" | "extrayendo" | "listo" | "error";
const nav = (estado: Fase, extra: Record<string, unknown> = {}) => ({ version: "148.0.1", tamano: 120 * MiB, estado, descargado: 0, error: null, ...extra });
const GPU = { chrome: "148", codificadores: [{ codificador: "h264_nvenc", adaptador: "NVIDIA" }] };
const NO_INSTALADO = "El módulo de vídeo no está instalado en esta versión de SEO Studio (llegará con una actualización).";

// Cada espera que depende del sondeo (1 s) con margen de sobra: no es una carrera contra el reloj.
const SONDEO = { timeout: 10_000 };
// POST que ningún test había previsto: el manejador por defecto lo cuenta y el afterEach falla.
let sinManejar = 0;

type Ctl = { nav: Record<string, unknown>; cap: [number, unknown]; onPost: () => [number, unknown]; rutaPost: boolean };

async function preparar(page: Page, inicial: Partial<Ctl> = {}, extra: Parameters<typeof simularRutas>[1] = {}) {
  const ctl: Ctl = {
    nav: nav("ausente"),
    cap: [200, GPU],
    rutaPost: true,
    onPost: () => {
      sinManejar++;
      return [500, { detail: "POST sin manejador en el test" }];
    },
    ...inicial,
  };
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/video/navegador/descarga")) posts.push(r.url());
  });
  const llamadas = await simularRutas(page, {
    "/video/navegador": () => [200, ctl.nav],
    "/video/navegador/descarga": (_u: URL, p: { metodo: string }) => (p.metodo === "POST" ? ctl.onPost() : [405, { detail: "x" }]),
    "/video/capacidades": () => ctl.cap,
    ...extra,
  });
  // Registrada después, tiene prioridad: con `rutaPost = false` (simula una ruta sin simular) el POST se
  // aborta aquí y no puede alcanzar ningún sidecar; si no, cede el paso al simulador.
  await page.route(/127\.0\.0\.1:\d+\/video\/navegador\/descarga/, (route) => (route.request().method() === "POST" && !ctl.rutaPost ? route.abort("failed") : route.fallback()));
  return { ctl, llamadas, posts };
}

test.describe("Ajustes › Motor de vídeo", () => {
  test.beforeEach(async ({ page }) => {
    sinManejar = 0;
    await page.emulateMedia({ colorScheme: "light" });
  });
  // El sidecar real no debe haber empezado ninguna descarga (en E2E el estado es temporal: «ausente»)
  // y ningún POST puede haber caído en el manejador por defecto.
  test.afterEach(async () => {
    expect(sinManejar).toBe(0);
    expect((await api<{ estado: string }>("/video/navegador")).estado).toBe("ausente");
  });

  const ir = async (page: Page) => {
    await page.goto("/#/ajustes");
    await expect(page.getByTestId("ajustes-video")).toBeVisible();
  };
  const v = (page: Page, id: string) => page.getByTestId(id);
  const barra = (page: Page) => v(page, "ajustes-video").getByRole("progressbar");

  test("flujo completo ausente → descargando → verificando → instalando → listo, con un único POST", async ({ page }) => {
    const { ctl, llamadas, posts } = await preparar(page);
    ctl.onPost = () => {
      ctl.nav = nav("descargando", { descargado: 48 * MiB });
      return [202, ctl.nav];
    };
    await ir(page);
    await expect(v(page, "ajustes-video-estado")).toHaveText("No descargado");
    await expect(v(page, "ajustes-video-aviso")).toContainText("Chrome for Testing 148.0.1 (~120 MB)");
    expect(posts).toHaveLength(0); // I14: cargar Ajustes no descarga nada
    await v(page, "ajustes-video-descargar").click();
    await expect(v(page, "ajustes-video-estado")).toHaveText("Descargando…");
    await expect(barra(page)).toHaveAttribute("aria-valuenow", "40");
    await expect(v(page, "ajustes-video-progreso")).toContainText("48 de 120 MB");
    await expect(v(page, "ajustes-video-descargar")).toHaveCount(0);
    ctl.nav = nav("verificando", { descargado: 120 * MiB });
    await expect(v(page, "ajustes-video-estado")).toHaveText("Verificando…", SONDEO);
    await expect(barra(page)).not.toHaveAttribute("aria-valuenow", /.+/, SONDEO);
    ctl.nav = nav("extrayendo", { descargado: 120 * MiB });
    await expect(v(page, "ajustes-video-estado")).toHaveText("Instalando…", SONDEO);
    ctl.nav = nav("listo", { descargado: 120 * MiB });
    await expect(v(page, "ajustes-video-estado")).toHaveText("Listo", SONDEO);
    await expect(v(page, "ajustes-video-progreso")).toHaveCount(0);
    await expect(v(page, "ajustes-video-descargar")).toHaveCount(0);
    expect(posts).toHaveLength(1);
    expect(llamadas["/video/navegador/descarga"]).toBe(1);
    await expect.poll(() => llamadas["/video/capacidades"]).toBe(1); // solo al estar listo
  });

  test("recargar con la descarga en marcha retoma el progreso y no ofrece otra descarga", async ({ page }) => {
    const { ctl, posts } = await preparar(page, { nav: nav("descargando", { descargado: 12 * MiB }) });
    await ir(page);
    await expect(barra(page)).toHaveAttribute("aria-valuenow", "10");
    await expect(v(page, "ajustes-video-descargar")).toHaveCount(0);
    await page.reload();
    await expect(barra(page)).toBeVisible();
    await expect(v(page, "ajustes-video-descargar")).toHaveCount(0);
    ctl.nav = nav("descargando", { descargado: 60 * MiB });
    await expect(barra(page)).toHaveAttribute("aria-valuenow", "50", SONDEO);
    expect(posts).toHaveLength(0);
  });

  test("doble clic: el 409 no rompe, la UI retoma el progreso y al llegar a listo no hay alerta", async ({ page }) => {
    const { ctl, posts } = await preparar(page);
    ctl.onPost = () => {
      ctl.nav = nav("descargando", { descargado: 6 * MiB });
      return [409, { detail: "Ya hay una descarga del navegador en curso." }];
    };
    await ir(page);
    await v(page, "ajustes-video-descargar").click();
    await expect(barra(page)).toBeVisible();
    await expect(v(page, "ajustes-video-descargar")).toHaveCount(0);
    expect(posts).toHaveLength(1);
    // Al llegar a «listo» el 409 de antes no reaparece como alerta.
    ctl.nav = nav("listo");
    await expect(v(page, "ajustes-video-estado")).toHaveText("Listo", SONDEO);
    await expect(v(page, "ajustes-video-error")).toHaveCount(0);
  });

  test("error de hash: alerta visible, reintentar hace un segundo POST y no se queda cargando", async ({ page }) => {
    const { ctl, llamadas, posts } = await preparar(page, { nav: nav("error", { error: "La descarga no coincide con el hash fijado; se ha descartado." }) });
    ctl.onPost = () => {
      ctl.nav = nav("descargando");
      return [202, ctl.nav];
    };
    await ir(page);
    await expect(v(page, "ajustes-video-estado")).toHaveText("Error");
    await expect(v(page, "ajustes-video-error")).toHaveText("La descarga no coincide con el hash fijado; se ha descartado.");
    await expect(v(page, "ajustes-video-error")).toHaveAttribute("role", "alert");
    expect(posts).toHaveLength(0); // L7: recargar en error no reintenta solo
    await expect(v(page, "ajustes-video-descargar")).toHaveText("Reintentar la descarga");
    await v(page, "ajustes-video-descargar").click();
    await expect(v(page, "ajustes-video-estado")).toHaveText("Descargando…");
    await expect(v(page, "ajustes-video-error")).toHaveCount(0);
    expect(posts).toHaveLength(1);
    expect(llamadas["/video/capacidades"] ?? 0).toBe(0);
  });

  test("el texto del backend se pinta como texto y sin rutas", async ({ page }) => {
    await preparar(page, { nav: nav("error", { error: "No se pudo escribir en C:\\Users\\Marc\\AppData\\Local\\x <img src=x onerror=alert(1)><script>window.__x=1</script>" }) });
    await ir(page);
    const alerta = v(page, "ajustes-video-error");
    await expect(alerta).toContainText("<img src=x onerror=alert(1)>");
    await expect(alerta).not.toContainText("AppData");
    await expect(alerta.locator("img, script")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __x?: number }).__x)).toBeUndefined();
  });

  test("módulo de vídeo no instalado (503): aviso claro y sin botón de descarga", async ({ page }) => {
    const { ctl, posts } = await preparar(page);
    ctl.onPost = () => [503, { detail: NO_INSTALADO }];
    await ir(page);
    await v(page, "ajustes-video-descargar").click();
    await expect(v(page, "ajustes-video-sin-motor")).toHaveText("El módulo de vídeo no está instalado en esta versión.");
    await expect(v(page, "ajustes-video-descargar")).toHaveCount(0);
    await expect(v(page, "ajustes-video-error")).toHaveCount(0);
    expect(posts).toHaveLength(1);
  });

  test("listo + capacidades 503 «no está instalado»: mismo aviso", async ({ page }) => {
    await preparar(page, { nav: nav("listo"), cap: [503, { detail: NO_INSTALADO }] });
    await ir(page);
    await expect(v(page, "ajustes-video-sin-motor")).toBeVisible();
    await expect(v(page, "ajustes-video-descargar")).toHaveCount(0);
  });

  test("M9: navegador listo pero corrupto → error y «Volver a descargar» que re-baja y vuelve a comprobar", async ({ page }) => {
    const { ctl, llamadas, posts } = await preparar(page, { nav: nav("listo"), cap: [503, { detail: "El navegador del render no pasa la verificación." }] });
    ctl.onPost = () => {
      ctl.nav = nav("descargando", { descargado: 1 * MiB });
      return [202, ctl.nav];
    };
    await ir(page);
    await expect(v(page, "ajustes-video-error")).toHaveText("El navegador del render no pasa la verificación.");
    await expect(v(page, "ajustes-video-sin-motor")).toHaveCount(0);
    await expect(v(page, "ajustes-video-descargar")).toHaveText("Volver a descargar");
    await expect(v(page, "ajustes-render-rapido-aviso")).toHaveText("No se han podido comprobar los codificadores");
    ctl.cap = [200, GPU];
    await v(page, "ajustes-video-descargar").click();
    await expect(v(page, "ajustes-video-estado")).toHaveText("Descargando…");
    await expect(v(page, "ajustes-video-error")).toHaveCount(0);
    ctl.nav = nav("listo");
    await expect(v(page, "ajustes-video-estado")).toHaveText("Listo");
    await expect(v(page, "ajustes-video-error")).toHaveCount(0);
    await expect(v(page, "ajustes-video-descargar")).toHaveCount(0);
    expect(posts).toHaveLength(1);
    expect(llamadas["/video/capacidades"]).toBe(2);
  });

  test("M9: 200 sin chrome y con gpu.detalle también ofrece volver a descargar", async ({ page }) => {
    await preparar(page, { nav: nav("listo"), cap: [200, { gpu: { webgpu: false, detalle: "Falta el navegador del render." } }] });
    await ir(page);
    await expect(v(page, "ajustes-video-error")).toHaveText("Falta el navegador del render.");
    await expect(v(page, "ajustes-video-descargar")).toHaveText("Volver a descargar");
  });

  test("I11: ni selector de ejecutable, ni input file, ni enlace a otro navegador", async ({ page }) => {
    await preparar(page, { nav: nav("error", { error: "fallo" }) });
    await ir(page);
    const sec = v(page, "ajustes-video");
    await expect(sec.locator("input[type=file]")).toHaveCount(0);
    await expect(sec.locator("input[type=text], input:not([type])")).toHaveCount(0);
    await expect(sec.locator("a")).toHaveCount(0);
    await expect(sec.getByRole("button", { name: /otro navegador|examinar|elegir.*chrome|edge/i })).toHaveCount(0);
  });

  test("modo: Automático por defecto, Compatible persiste tras recargar y avisa", async ({ page }) => {
    await preparar(page);
    await ir(page);
    await expect(v(page, "ajustes-render-modo-auto")).toHaveAttribute("aria-checked", "true");
    await expect(v(page, "ajustes-render-modo-auto")).toContainText("Dos pasadas; funciona en cualquier equipo");
    await v(page, "ajustes-render-modo-compatible").click();
    await expect(page.getByRole("status").filter({ hasText: "Modo de render guardado" }).first()).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("seo-studio.render-modo"))).toBe("compatible");
    await page.reload();
    await expect(v(page, "ajustes-render-modo-compatible")).toHaveAttribute("aria-checked", "true");
    await expect(v(page, "ajustes-render-modo-nota")).toHaveCount(0);
  });

  test("nota_retirada: el modo ya se aplica al render y la nota de «todavía no» no existe", async ({ page }) => {
    await preparar(page);
    await ir(page);
    await expect(v(page, "ajustes-render-modo")).toBeVisible();
    await expect(v(page, "ajustes-render-modo-nota")).toHaveCount(0);
    await expect(v(page, "ajustes-video")).not.toContainText("todavía no se aplica");
  });

  test("modo: Rápido deshabilitado sin navegador listo, con solo h264_mf, y habilitado con GPU", async ({ page }) => {
    const { ctl, llamadas } = await preparar(page);
    await ir(page);
    await expect(v(page, "ajustes-render-modo-rapido")).toBeDisabled();
    await expect(v(page, "ajustes-render-rapido-aviso")).toHaveText("Descarga el navegador del render para comprobar los codificadores");
    expect(llamadas["/video/capacidades"] ?? 0).toBe(0); // sin navegador listo no se pide

    ctl.nav = nav("listo");
    ctl.cap = [200, { chrome: "148", codificadores: [{ codificador: "h264_mf", adaptador: "Microsoft" }] }];
    await page.reload();
    await expect(v(page, "ajustes-render-rapido-aviso")).toHaveText("No hay codificador de GPU: se usará Compatible");
    await expect(v(page, "ajustes-render-modo-rapido")).toBeDisabled();

    ctl.cap = [200, GPU];
    await page.reload();
    await expect(v(page, "ajustes-render-modo-rapido")).toBeEnabled();
    await expect(v(page, "ajustes-render-rapido-aviso")).toHaveCount(0);
    await v(page, "ajustes-render-modo-rapido").click();
    await expect(v(page, "ajustes-render-modo-rapido")).toHaveAttribute("aria-checked", "true");
  });

  test("«Rápido» guardado sin GPU no queda marcado: se marca Compatible y lo guardado se conserva", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("seo-studio.render-modo", "rapido"));
    await preparar(page, { nav: nav("listo"), cap: [200, { chrome: "148", codificadores: [] }] });
    await ir(page);
    await expect(v(page, "ajustes-render-rapido-aviso")).toHaveText("No hay codificador de GPU: se usará Compatible");
    await expect(v(page, "ajustes-render-modo-rapido")).toBeDisabled();
    await expect(v(page, "ajustes-render-modo-rapido")).toHaveAttribute("aria-checked", "false");
    await expect(v(page, "ajustes-render-modo-compatible")).toHaveAttribute("aria-checked", "true");
    expect(await page.evaluate(() => localStorage.getItem("seo-studio.render-modo"))).toBe("rapido");
  });

  test("la subnavegación tiene seis botones y «Motor de vídeo» desplaza a su sección", async ({ page }) => {
    await preparar(page);
    await ir(page);
    await expect(v(page, "ajustes-subnav").getByRole("button")).toHaveText(["General", "Canales de YouTube", "Carpetas permitidas", "Clave de Anthropic", "Motor de vídeo", "Avanzado"]);
    await v(page, "ajustes-nav-video").click();
    await expect(v(page, "ajustes-nav-video")).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("heading", { name: "Motor de vídeo" })).toBeInViewport();
  });

  test("el bloqueo funciona: un POST sin simular no llega al sidecar real (control)", async ({ page }) => {
    // El simulador atiende el POST (aquí con un 500 propio): nunca llega al sidecar real.
    const { ctl, posts } = await preparar(page);
    let atendidos = 0;
    ctl.onPost = () => {
      atendidos++;
      return [500, { detail: "bloqueado por el test" }];
    };
    await ir(page);
    await v(page, "ajustes-video-descargar").click();
    await expect(v(page, "ajustes-video-error")).toHaveText("bloqueado por el test");
    expect(atendidos).toBe(1);
    expect(posts).toHaveLength(1); // salió de la página, pero lo atendió el simulador, no el sidecar
    // y el sidecar real sigue sin descarga (lo comprueba además el afterEach)
    expect((await api<{ estado: string }>("/video/navegador")).estado).toBe("ausente");
  });

  test("negativo: sin la ruta simulada el POST se aborta y no alcanza ningún sidecar", async ({ page }) => {
    const { ctl, posts } = await preparar(page);
    const abortados: string[] = [];
    page.on("requestfailed", (r) => {
      if (r.method() === "POST" && r.url().includes("/video/navegador/descarga")) abortados.push(r.url());
    });
    ctl.rutaPost = false;
    await ir(page);
    await v(page, "ajustes-video-descargar").click();
    await expect(v(page, "ajustes-video-error")).toBeVisible();
    expect(posts).toHaveLength(1);
    expect(abortados).toHaveLength(1); // abortado en el navegador: ni simulador ni sidecar real
    expect(sinManejar).toBe(0);
    expect((await api<{ estado: string }>("/video/navegador")).estado).toBe("ausente");
  });
});

/** Clave de ElevenLabs. `/settings` y la validación se simulan SIEMPRE: la validación real llamaría a
 *  api.elevenlabs.io y el PUT real escribiría en el almacén de secretos del sidecar de los E2E. */
test.describe("Ajustes › Clave de ElevenLabs", () => {
  const CLAVE = "xi-e2e-secreta-0123456789";
  test.beforeEach(async ({ page }) => {
    sinManejar = 0;
    await page.emulateMedia({ colorScheme: "light" });
  });

  async function preparaClave(page: Page, valida: [boolean, string | null] = [true, null]) {
    const real = await api<Settings>("/settings");
    const est = { configurada: false, puts: [] as unknown[], validaciones: [] as unknown[] };
    await preparar(page, {}, {
      "/settings": (_u: URL, p: { metodo: string; cuerpo: unknown }) => {
        if (p.metodo === "PUT") {
          est.puts.push(p.cuerpo);
          est.configurada = (p.cuerpo as { elevenlabs_api_key?: string }).elevenlabs_api_key !== "";
        }
        return [200, { ...real, has_elevenlabs_key: est.configurada }];
      },
      "/settings/validate-elevenlabs-key": (_u: URL, p: { cuerpo: unknown }) => {
        est.validaciones.push(p.cuerpo);
        return [200, { valida: valida[0], detalle: valida[1] }];
      },
    });
    await page.goto("/#/ajustes");
    await expect(page.getByTestId("ajustes-eleven-estado")).toBeVisible();
    return est;
  }
  const storage = (page: Page) => page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));

  test("clave_nunca_en_dom: se valida, se envía una vez, el campo queda vacío y no hay rastro de la clave", async ({ page }) => {
    const est = await preparaClave(page);
    const campo = page.getByTestId("ajustes-eleven-clave");
    await expect(page.getByTestId("ajustes-eleven-estado")).toHaveText("No configurada");
    await expect(campo).toHaveAttribute("type", "password");
    await expect(page.getByTestId("ajustes-eleven-borrar")).toHaveCount(0);
    await campo.fill(CLAVE);
    await page.getByTestId("ajustes-eleven-guardar").click();
    await expect(page.getByTestId("ajustes-eleven-estado")).toHaveText("Configurada");
    expect(est.validaciones).toEqual([{ api_key: CLAVE }]);
    expect(est.puts).toEqual([{ elevenlabs_api_key: CLAVE }]);
    await expect(campo).toHaveValue("");
    expect(await page.content()).not.toContain(CLAVE);
    expect(await storage(page)).not.toContain(CLAVE);
    await page.reload();
    await expect(page.getByTestId("ajustes-eleven-estado")).toHaveText("Configurada");
    await expect(campo).toHaveValue("");
    expect(await page.content()).not.toContain(CLAVE);
  });

  test("una clave que ElevenLabs no reconoce no se guarda y se explica", async ({ page }) => {
    const est = await preparaClave(page, [false, "ElevenLabs no reconoce esta clave."]);
    await page.getByTestId("ajustes-eleven-clave").fill(CLAVE);
    await page.getByTestId("ajustes-eleven-guardar").click();
    await expect(page.getByTestId("ajustes-eleven-error")).toHaveText("ElevenLabs no reconoce esta clave.");
    await expect(page.getByTestId("ajustes-eleven-estado")).toHaveText("No configurada");
    expect(est.puts).toEqual([]);
    expect(await page.content()).not.toContain(CLAVE);
  });

  test("borrar envía la cadena vacía y vuelve a «No configurada»", async ({ page }) => {
    const est = await preparaClave(page);
    await page.getByTestId("ajustes-eleven-clave").fill(CLAVE);
    await page.getByTestId("ajustes-eleven-guardar").click();
    await expect(page.getByTestId("ajustes-eleven-estado")).toHaveText("Configurada");
    await page.getByTestId("ajustes-eleven-borrar").click();
    await expect(page.getByTestId("ajustes-eleven-estado")).toHaveText("No configurada");
    expect(est.puts.at(-1)).toEqual({ elevenlabs_api_key: "" });
    await expect(page.getByTestId("ajustes-eleven-borrar")).toHaveCount(0);
  });
});

