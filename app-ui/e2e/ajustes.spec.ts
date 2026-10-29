/** Ajustes rediseñados (artboard "Ajustes (claro)"): secciones con guardado automático. Sidecar
 *  real salvo en el test de perfiles nuevos (el OAuth no existe en el entorno de pruebas). */
import { expect, test } from "@playwright/test";
import { settings, youtube } from "./api";
import { simularRutas } from "./sidecar-falso";

const aviso = (page: import("@playwright/test").Page, texto: string) => page.getByRole("status").filter({ hasText: texto }).first();

test.describe("Ajustes", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/#/ajustes");
    await expect(page.getByTestId("ajustes-form")).toBeVisible();
  });

  test("sin botón Guardar; subnavegación por secciones con la activa marcada", async ({ page }) => {
    await expect(page.getByRole("button", { name: /^Guardar$/ })).toHaveCount(0);
    await expect(page.getByTestId("ajustes-guardar")).toHaveCount(0);
    const nav = page.getByTestId("ajustes-subnav");
    await expect(nav.getByRole("button")).toHaveText(["General", "Canales de YouTube", "Carpetas permitidas", "Clave de Anthropic", "Avanzado"]);
    await expect(page.getByTestId("ajustes-nav-general")).toHaveAttribute("aria-current", "true");
    await page.getByTestId("ajustes-nav-carpetas").click();
    await expect(page.getByTestId("ajustes-nav-carpetas")).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("ajustes-nav-general")).not.toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("heading", { name: "Carpetas permitidas" })).toBeInViewport();
  });

  test("modelo: tarjetas con precio, el cambio se guarda solo y avisa", async ({ page }) => {
    const s = await settings();
    const grupo = page.getByTestId("ajustes-model");
    await expect(grupo.getByRole("radio")).toHaveCount(s.models.length);
    await expect(grupo.getByRole("radio", { name: /Opus 5.5/ })).toContainText("4 $ / 20 $ por Mtok");
    await expect(grupo.getByRole("radio", { name: /Sonnet 5.5/ })).toContainText("2 $ / 10 $ por Mtok");
    await expect(page.getByTestId(`ajustes-model-${s.model}`)).toHaveAttribute("aria-checked", "true");

    const otro = s.models.find((m) => m !== s.model)!;
    await page.getByTestId(`ajustes-model-${otro}`).click();
    await expect(aviso(page, "Modelo guardado")).toBeVisible();
    await expect(page.getByTestId(`ajustes-model-${otro}`)).toHaveAttribute("aria-checked", "true");
    expect((await settings()).model).toBe(otro);
    await page.getByTestId(`ajustes-model-${s.model}`).click();
    await expect.poll(async () => (await settings()).model).toBe(s.model);
  });

  test("apariencia: Sistema / Claro / Oscuro cambia data-theme y se recuerda", async ({ page }) => {
    const tema = page.getByTestId("ajustes-tema");
    await tema.getByRole("radio", { name: "Oscuro" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("seo-studio.tema"))).toBe("dark");
    await tema.getByRole("radio", { name: "Claro" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await tema.getByRole("radio", { name: "Sistema" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    await expect(tema.getByRole("radio", { name: "Sistema" })).toBeChecked();
  });

  test("clave: se envía una vez, queda enmascarada, se reemplaza y el borrado pide confirmación", async ({ page }) => {
    const campo = page.getByTestId("ajustes-key");
    if (!(await settings()).has_anthropic_key) {
      await expect(page.getByTestId("ajustes-key-guardar")).toBeDisabled();
      await expect(campo).toHaveAttribute("type", "password");
      await expect(campo).toHaveValue("");
      await campo.fill("sk-ant-otra-clave-e2e");
      await page.getByTestId("ajustes-key-guardar").click();
      await expect(aviso(page, "Clave guardada")).toBeVisible();
    }
    await expect(campo).toHaveCount(0); // con clave guardada no se pide otra hasta "Reemplazar"
    await expect(page.getByTestId("ajustes-key-estado")).toContainText("sk-ant-••••");
    await expect(page.getByTestId("ajustes-key-estado")).toContainText("Guardada en");
    expect((await settings()).has_anthropic_key).toBe(true);
    expect(await page.content()).not.toContain("sk-ant-otra-clave-e2e");

    await page.getByTestId("ajustes-key-reemplazar").click();
    await expect(campo).toHaveValue("");
    await campo.fill("sk-ant-reemplazo-e2e");
    await page.getByTestId("ajustes-key-guardar").click();
    await expect(aviso(page, "Clave guardada")).toBeVisible();
    await expect(campo).toHaveCount(0);
    expect(await page.content()).not.toContain("sk-ant-reemplazo-e2e");

    // borrar: cancelar no hace nada; confirmar borra; y se vuelve a guardar una (los E2E de chat la necesitan)
    await page.getByTestId("ajustes-key-borrar").click();
    const dialogo = page.getByRole("dialog", { name: "¿Borrar la clave de Anthropic?" });
    await dialogo.getByRole("button", { name: "Cancelar" }).click();
    expect((await settings()).has_anthropic_key).toBe(true);
    await page.getByTestId("ajustes-key-borrar").click();
    await page.getByRole("dialog").getByRole("button", { name: "Borrar clave" }).click();
    await expect(page.getByTestId("ajustes-key-estado")).toHaveText("Sin clave");
    expect((await settings()).has_anthropic_key).toBe(false);
    await campo.fill("sk-ant-final-e2e");
    await page.getByTestId("ajustes-key-guardar").click();
    await expect(page.getByTestId("ajustes-key-estado")).toContainText("Guardada en");
  });

  test("carpetas: alta a mano, idioma como selector y baja, todo guardado al momento", async ({ page }) => {
    const antes = (await settings()).allowed_dirs.length;
    await expect(page.getByTestId("ajustes-dir")).toHaveCount(antes);
    await expect(page.getByTestId("ajustes-dir-add")).toBeDisabled();
    const ruta = "C:\\Users\\Marc\\Videos\\E2E";
    await page.getByTestId("ajustes-dir-path").fill(ruta);
    await page.getByTestId("ajustes-dir-lang").selectOption("en");
    await page.getByTestId("ajustes-dir-add").click();
    await expect(aviso(page, "Carpeta añadida")).toBeVisible();
    await expect(page.getByTestId("ajustes-dir")).toHaveCount(antes + 1);
    expect((await settings()).allowed_dirs).toContainEqual({ path: ruta, language: "en" });

    const fila = page.getByTestId("ajustes-dir").last();
    await fila.getByRole("combobox").selectOption("");
    await expect(aviso(page, "Idioma guardado")).toBeVisible();
    expect((await settings()).allowed_dirs).toContainEqual({ path: ruta, language: null });

    await page.getByTestId("ajustes-dir-path").fill(ruta); // duplicada
    await page.getByTestId("ajustes-dir-add").click();
    await expect(page.getByText("Esa carpeta ya está en la lista.")).toBeVisible();

    await fila.getByRole("button", { name: `Quitar la carpeta ${ruta}` }).click();
    await expect(aviso(page, "Carpeta quitada")).toBeVisible();
    expect((await settings()).allowed_dirs.length).toBe(antes);
  });

  test("'Elegir carpeta…' fuera de Tauri no abre nada ni cambia la lista", async ({ page }) => {
    const antes = (await settings()).allowed_dirs.length;
    await page.getByTestId("ajustes-dir-elegir").click();
    await expect(page.getByTestId("ajustes-dir")).toHaveCount(antes);
  });

  test("canales: perfil en uso con estado, cuota legible, información y asistente", async ({ page }) => {
    const yt = await youtube();
    const s = await settings();
    const perfiles = page.getByTestId("ajustes-profile");
    for (const p of new Set([...yt.auth.profiles, s.profile])) await expect(perfiles.getByTestId(`ajustes-profile-${p}`)).toBeVisible();
    await expect(page.getByTestId(`ajustes-profile-${s.profile}`)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("ajustes-yt-estado")).toHaveText(yt.auth.authenticated ? "Autorizado" : "Sin autorizar");
    await expect(page.getByTestId("ajustes-yt-reauth")).toHaveText("Volver a autorizar");
    const miles = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    for (const [b, v] of Object.entries(yt.quota.buckets)) {
      await expect(page.getByTestId(`cuota-${b}`)).toContainText(`${miles(v.used)} de ${miles(v.limit)}`);
    }
    await expect(page.locator("main")).toContainText(s.state_dir);
    await expect(page.locator("main")).toContainText(s.secret_store);
    await expect(page.getByTestId("ajustes-avanzado")).toHaveCount(0);
    await expect(page.locator("#ajustes-avanzado")).toContainText(/Fichero local \(modo de pruebas\)|Administrador de credenciales de Windows/);
    await page.getByTestId("ajustes-asistente").click();
    await expect(page).toHaveURL(/#\/onboarding$/);
  });
});

test.describe("Ajustes: perfiles de YouTube (sidecar simulado)", () => {
  test("'Añadir canal…' pide un nombre, autoriza ese perfil y lo deja en uso; 'Usar este' cambia de perfil", async ({ page }) => {
    const base = await settings();
    const estado = { ...base, profile: "default", has_client_secret: true };
    let perfiles = ["default", "viejo"];
    const peticiones: Array<{ ruta: string; cuerpo: unknown }> = [];
    await simularRutas(page, {
      "/settings": (_u, p) => {
        if (p.metodo === "PUT") {
          peticiones.push({ ruta: "PUT /settings", cuerpo: p.cuerpo });
          Object.assign(estado, p.cuerpo as object);
        }
        return [200, estado];
      },
      "/youtube/status": () => [200, { auth: { profile: estado.profile, profiles: perfiles, authenticated: true, store: "x" }, quota: { buckets: { general: { used: 1, limit: 10000 }, search: { used: 0, limit: 100 }, video_insert: { used: 0, limit: 100 } } } }],
      "/youtube/auth": (_u, p) => {
        peticiones.push({ ruta: "POST /youtube/auth", cuerpo: p.cuerpo });
        perfiles = [...perfiles, (p.cuerpo as { profile: string }).profile];
        return [200, { status: "authenticated", detail: { profile: estado.profile, profiles: perfiles, authenticated: true, store: "x" }, duplicated_in: [] }];
      },
    });
    await page.goto("/#/ajustes");
    await expect(page.getByTestId("ajustes-profile-viejo")).toBeVisible();
    await expect(page.getByTestId("ajustes-yt-reauth")).toHaveCount(1); // solo el perfil en uso

    await page.getByTestId("ajustes-yt-anadir").click();
    const dialogo = page.getByRole("dialog", { name: "Añadir un canal de YouTube" });
    await expect(dialogo.getByTestId("ajustes-yt-anadir-ok")).toBeDisabled();
    await dialogo.getByTestId("ajustes-yt-nombre").fill("Nombre Mal!");
    await expect(dialogo.getByText("Nombre no válido")).toBeVisible();
    await expect(dialogo.getByTestId("ajustes-yt-anadir-ok")).toBeDisabled();
    await dialogo.getByTestId("ajustes-yt-nombre").fill("Smooth");
    await dialogo.getByTestId("ajustes-yt-anadir-ok").click();
    await expect(dialogo).toHaveCount(0);
    expect(peticiones).toEqual([
      { ruta: "POST /youtube/auth", cuerpo: { profile: "smooth", reauthorize: true } },
      { ruta: "PUT /settings", cuerpo: { profile: "smooth" } },
    ]);
    await expect(page.getByTestId("ajustes-profile-smooth")).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("status").filter({ hasText: "Canal añadido y en uso" }).first()).toBeVisible();

    await page.getByTestId("ajustes-yt-usar-viejo").click();
    await expect(page.getByTestId("ajustes-profile-viejo")).toHaveAttribute("aria-current", "true");
    expect(peticiones.at(-1)).toEqual({ ruta: "PUT /settings", cuerpo: { profile: "viejo" } });
  });
});

test.describe("Ajustes: autorización interrumpida (sidecar simulado)", () => {
  /** El navegador nunca vuelve de Google: POST /youtube/auth queda pendiente hasta que se cancela. */
  async function sinRespuestaDeGoogle(page: import("@playwright/test").Page) {
    const base = await settings();
    const estado = { ...base, profile: "default", has_client_secret: true };
    let responder: (r: [number, unknown]) => void = () => undefined;
    const llamadas = await simularRutas(page, {
      "/settings": estado,
      "/youtube/status": { auth: { profile: "default", profiles: ["default"], authenticated: true, store: "x" }, quota: { buckets: { general: { used: 1, limit: 10000 }, search: { used: 0, limit: 100 }, video_insert: { used: 0, limit: 100 } } } },
      "/youtube/auth": () => new Promise<[number, unknown]>((r) => (responder = r)),
      "/youtube/auth/cancel": () => {
        responder([400, { detail: "Autorización cancelada." }]);
        return [200, { cancelada: true }];
      },
    });
    await page.goto("/#/ajustes");
    return llamadas;
  }

  test("'Añadir canal': Cancelar corta la autorización pendiente y la app sigue navegable", async ({ page }) => {
    const llamadas = await sinRespuestaDeGoogle(page);
    await page.getByTestId("ajustes-yt-anadir").click();
    const dialogo = page.getByRole("dialog", { name: "Añadir un canal de YouTube" });
    await dialogo.getByTestId("ajustes-yt-nombre").fill("smooth");
    await dialogo.getByTestId("ajustes-yt-anadir-ok").click();
    await expect(dialogo.getByTestId("ajustes-yt-anadir-ok")).toHaveText("Se ha abierto el navegador…");
    await expect(dialogo.getByTestId("ajustes-yt-ayuda-google")).toContainText("usuario de prueba");
    await dialogo.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialogo).toHaveCount(0);
    await expect.poll(() => llamadas["/youtube/auth/cancel"]).toBe(1);
    await expect(page.getByTestId("ajustes-profile-default")).toHaveAttribute("aria-current", "true");
    // al volver a abrirlo no arrastra el intento anterior
    await page.getByTestId("ajustes-yt-anadir").click();
    await expect(dialogo.getByTestId("ajustes-yt-anadir-ok")).toHaveText("Autorizar canal");
    await page.keyboard.press("Escape");
    await page.getByTestId("nav-chat").click();
    await expect(page).toHaveURL(/#\/chat$/);
  });

  test("'Añadir canal': Escape durante la espera también cancela", async ({ page }) => {
    const llamadas = await sinRespuestaDeGoogle(page);
    await page.getByTestId("ajustes-yt-anadir").click();
    const dialogo = page.getByRole("dialog", { name: "Añadir un canal de YouTube" });
    await dialogo.getByTestId("ajustes-yt-nombre").fill("smooth");
    await dialogo.getByTestId("ajustes-yt-anadir-ok").click();
    await expect(dialogo.getByTestId("ajustes-yt-anadir-ok")).toHaveText("Se ha abierto el navegador…");
    await page.keyboard.press("Escape");
    await expect(dialogo).toHaveCount(0);
    await expect.poll(() => llamadas["/youtube/auth/cancel"]).toBe(1);
  });

  test("'Volver a autorizar' ofrece Cancelar mientras espera al navegador", async ({ page }) => {
    const llamadas = await sinRespuestaDeGoogle(page);
    await page.getByTestId("ajustes-yt-reauth").click();
    await expect(page.getByTestId("ajustes-yt-reauth")).toHaveText("Se ha abierto el navegador…");
    await page.getByTestId("ajustes-yt-reauth-cancelar").click();
    await expect(page.getByTestId("ajustes-yt-reauth")).toHaveText("Volver a autorizar");
    await expect(page.getByTestId("ajustes-yt-reauth-cancelar")).toHaveCount(0);
    expect(llamadas["/youtube/auth/cancel"]).toBe(1);
  });
});

test.describe("Ajustes: un proyecto de Google para todos los canales (sidecar simulado)", () => {
  const CUOTA = { buckets: { general: { used: 1, limit: 10000 }, search: { used: 0, limit: 100 }, video_insert: { used: 0, limit: 100 } } };
  const PROYECTO = { project_id: "mi-proyecto", client_id: "123456…wxyz" };
  const CANAL_A = { id: "UC1", title: "Canal A", handle: "@a" };
  const OTRO_JSON = JSON.stringify({ installed: { client_id: "2-b.apps.googleusercontent.com", client_secret: "s", project_id: "proyecto-b" } });

  /** Sidecar con proyecto y dos perfiles autorizados (default en uso); `rutas` sustituye las que haga falta. */
  async function conProyecto(page: import("@playwright/test").Page, ajustes: Record<string, unknown> = {}, rutas: Parameters<typeof simularRutas>[1] = {}) {
    const estado: Record<string, unknown> = { ...(await settings()), profile: "default", has_client_secret: true, google_project: PROYECTO, ...ajustes };
    const auth = { profile: "default", profiles: ["default", "viejo"], authenticated: true, store: "x", channel: CANAL_A, channels: { default: CANAL_A, viejo: { id: "UC2", title: "Canal B", handle: null } } };
    const llamadas = await simularRutas(page, {
      "/settings": (_u, p) => {
        if (p.metodo === "PUT") Object.assign(estado, p.cuerpo as object);
        return [200, estado];
      },
      "/youtube/status": { auth, quota: CUOTA },
      ...rutas,
    });
    await page.goto("/#/ajustes");
    return { estado, auth, llamadas };
  }

  test("muestra el proyecto, el canal de cada perfil y el canal en uso en la barra lateral", async ({ page }) => {
    await conProyecto(page);
    await expect(page.getByTestId("ajustes-google-proyecto")).toContainText("mi-proyecto · cliente 123456…wxyz");
    await expect(page.getByTestId("ajustes-canal-default")).toHaveText("Canal A");
    await expect(page.getByTestId("ajustes-profile-default")).toContainText("Perfil default · @a · En uso");
    await expect(page.getByTestId("ajustes-canal-viejo")).toHaveText("Canal B");
    await expect(page.getByTestId("ajustes-profile-viejo")).toContainText("Perfil viejo · Guardado");
    await expect(page.getByTestId("nav-canal-activo")).toHaveText("Canal A");
  });

  test("sustituir por otro proyecto pide confirmación porque desautoriza los canales", async ({ page }) => {
    const cuerpos: unknown[] = [];
    const { estado } = await conProyecto(page, {}, {
      "/settings/client-secret": (_u, p) => {
        cuerpos.push(p.cuerpo);
        if (!(p.cuerpo as { replace?: boolean }).replace) {
          return [409, { detail: "Este client_secret.json es de otro proyecto de Google. Sustituirlo desautoriza el canal/los canales default, viejo: tendrás que volver a autorizarlos." }];
        }
        estado.google_project = { project_id: "proyecto-b", client_id: "2-b.ap….com" };
        return [200, { ...estado, desautorizados: ["default", "viejo"] }];
      },
    });
    await page.getByTestId("ajustes-google-sustituir").click();
    const importar = page.getByRole("dialog", { name: "Sustituir el proyecto de Google" });
    await importar.getByTestId("google-json").fill(OTRO_JSON);
    await importar.getByTestId("google-importar").click();
    const confirmar = page.getByRole("dialog", { name: "¿Sustituir el proyecto de Google?" });
    await expect(confirmar).toContainText("desautoriza el canal/los canales default, viejo");
    await confirmar.getByRole("button", { name: "Sustituir y desautorizar" }).click();
    expect(cuerpos).toEqual([{ json_text: OTRO_JSON }, { json_text: OTRO_JSON, replace: true }]);
    await expect(aviso(page, "Proyecto de Google sustituido")).toContainText("Vuelve a autorizar: default, viejo.");
    await expect(importar).toHaveCount(0);
    await expect(page.getByTestId("ajustes-google-proyecto")).toContainText("proyecto-b");
  });

  test("cancelar la confirmación no sustituye nada", async ({ page }) => {
    const cuerpos: unknown[] = [];
    await conProyecto(page, {}, {
      "/settings/client-secret": (_u, p) => {
        cuerpos.push(p.cuerpo);
        return [409, { detail: "Este client_secret.json es de otro proyecto de Google." }];
      },
    });
    await page.getByTestId("ajustes-google-sustituir").click();
    const importar = page.getByRole("dialog", { name: "Sustituir el proyecto de Google" });
    await importar.getByTestId("google-json").fill(OTRO_JSON);
    await importar.getByTestId("google-importar").click();
    await page.getByRole("dialog", { name: "¿Sustituir el proyecto de Google?" }).getByRole("button", { name: "Cancelar" }).click();
    await expect(page.getByRole("dialog", { name: "¿Sustituir el proyecto de Google?" })).toHaveCount(0);
    expect(cuerpos).toHaveLength(1);
    await expect(importar.getByTestId("google-json")).toHaveValue(OTRO_JSON); // el usuario no pierde lo que pegó
  });

  test("quitar el proyecto pide confirmación y deja Ajustes sin proyecto", async ({ page }) => {
    const metodos: string[] = [];
    const { estado } = await conProyecto(page, {}, {
      "/settings/client-secret": (_u, p) => {
        metodos.push(p.metodo);
        Object.assign(estado, { has_client_secret: false, google_project: null });
        return [200, { ...estado, desautorizados: ["default", "viejo"] }];
      },
    });
    await page.getByTestId("ajustes-google-eliminar").click();
    const confirmar = page.getByRole("dialog", { name: "¿Quitar el proyecto de Google?" });
    await expect(confirmar).toContainText("Se desautorizarán todos los canales (default, viejo)");
    await confirmar.getByRole("button", { name: "Quitar y desautorizar" }).click();
    expect(metodos).toEqual(["DELETE"]);
    await expect(aviso(page, "Proyecto de Google quitado")).toContainText("Desautorizados: default, viejo.");
    await expect(page.getByTestId("ajustes-google-proyecto")).toContainText("Sin proyecto");
    await expect(page.getByTestId("ajustes-google-sustituir")).toHaveText("Importar client_secret.json");
    await expect(page.getByTestId("ajustes-google-eliminar")).toHaveCount(0);
  });

  test("sin proyecto, 'Añadir canal' explica qué falta y lleva a importarlo", async ({ page }) => {
    const { llamadas } = await conProyecto(page, { has_client_secret: false, google_project: null }, { "/youtube/auth": {} });
    await page.getByTestId("ajustes-yt-anadir").click();
    const dialogo = page.getByRole("dialog", { name: "Añadir un canal de YouTube" });
    await dialogo.getByTestId("ajustes-yt-nombre").fill("smooth");
    await expect(dialogo.getByTestId("ajustes-yt-sin-proyecto")).toContainText("hace falta el proyecto de Google Cloud");
    await expect(dialogo.getByTestId("ajustes-yt-anadir-ok")).toBeDisabled();
    await dialogo.getByTestId("ajustes-yt-sin-proyecto").getByRole("button", { name: "Importar client_secret.json" }).click();
    await expect(dialogo).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Importar el proyecto de Google" }).getByTestId("google-importar")).toBeVisible();
    expect(llamadas["/youtube/auth"]).toBeUndefined();
  });

  test("autorizar un canal que ya estaba en otro perfil avisa del duplicado", async ({ page }) => {
    await conProyecto(page, {}, {
      "/youtube/auth": () => [200, { status: "authenticated", detail: { profile: "smooth", profiles: ["default", "viejo", "smooth"], authenticated: true, store: "x", channel: CANAL_A }, duplicated_in: ["default"] }],
    });
    await page.getByTestId("ajustes-yt-anadir").click();
    const dialogo = page.getByRole("dialog", { name: "Añadir un canal de YouTube" });
    await dialogo.getByTestId("ajustes-yt-nombre").fill("smooth");
    await dialogo.getByTestId("ajustes-yt-anadir-ok").click();
    await expect(aviso(page, "Canal añadido y en uso")).toContainText("Canal A (@a) ya estaba autorizado en el perfil default");
  });

  test("si Google rechaza la autorización, el error lleva a sustituir el client_secret.json", async ({ page }) => {
    await conProyecto(page, {}, {
      "/youtube/auth": () => [400, { detail: "Google no reconoce el cliente OAuth de este client_secret.json." }],
    });
    await page.getByTestId("ajustes-yt-anadir").click();
    const dialogo = page.getByRole("dialog", { name: "Añadir un canal de YouTube" });
    await dialogo.getByTestId("ajustes-yt-nombre").fill("smooth");
    await dialogo.getByTestId("ajustes-yt-anadir-ok").click();
    await expect(dialogo).toContainText("Google no reconoce el cliente OAuth");
    const ayuda = dialogo.getByTestId("ajustes-yt-error-ayuda");
    await expect(ayuda.getByRole("link", { name: "credenciales" })).toHaveAttribute("href", "https://console.cloud.google.com/apis/credentials");
    await ayuda.getByRole("button", { name: "Sustituir client_secret.json" }).click();
    await expect(page.getByRole("dialog", { name: "Sustituir el proyecto de Google" }).getByTestId("google-importar")).toBeVisible();
  });
});
