/** Chats guardados (SEO-100): sobreviven a cerrar la app, se borran con confirmación y cada uno
 *  pertenece al canal (perfil) con el que se creó. Sidecar real salvo en el filtro por canal. */
import { expect, test, type Page } from "@playwright/test";
import { settings } from "./api";
import { simularRutas } from "./sidecar-falso";

/** El chat de la lista con ese título (los guardados tienen id `chat:<id del sidecar>`). */
const enLista = (page: Page, titulo: string) => page.getByTestId("nav-conversaciones").getByRole("button", { name: titulo, exact: true });

test("un chat sigue ahí al reabrir la app, con sus mensajes, y se puede borrar para siempre", async ({ page }) => {
  const titulo = `Persiste E2E-TEXTO ${Date.now()}`;
  await page.goto("/#/chat");
  await page.getByTestId("chat-input").fill(titulo);
  await page.getByTestId("chat-enviar").click();
  await expect(page.getByTestId("msg-assistant").getByTestId("bloque-texto")).not.toHaveText("");
  await expect(page.getByTestId("chat-enviar")).toBeVisible(); // turno terminado

  // "Cerrar y abrir la app": la página se carga de cero y la lista sale del sidecar.
  await page.reload();
  await expect(page.getByTestId("chat-vacio")).toBeVisible(); // arranca en un chat nuevo
  await enLista(page, titulo).click();
  await expect(page.getByTestId("msg-user")).toHaveText(titulo);
  await expect(page.getByTestId("msg-assistant")).toHaveCount(1);
  await expect(page.getByTestId("chat-header").getByRole("heading", { level: 1 })).toHaveText(titulo.split(/\s+/).slice(0, 6).join(" "));

  // Borrar pide confirmación; cancelar no borra.
  const borrarlo = page.getByTestId("nav-conversaciones").getByRole("button", { name: `Borrar la conversación «${titulo}»` });
  await borrarlo.click();
  const confirmar = page.getByRole("dialog", { name: "¿Borrar la conversación?" });
  await expect(confirmar).toContainText(`«${titulo}» se borrará de este equipo y no se podrá recuperar.`);
  await confirmar.getByRole("button", { name: "Cancelar" }).click();
  await expect(enLista(page, titulo)).toBeVisible();

  await borrarlo.click();
  await confirmar.getByRole("button", { name: "Borrar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Conversación borrada" }).first()).toBeVisible();
  await expect(enLista(page, titulo)).toHaveCount(0);
  await expect(page.getByTestId("chat-vacio")).toBeVisible(); // el abierto era ese: pasa a otro vacío
  await page.reload();
  await expect(page.getByTestId("nav-conversaciones")).toBeVisible();
  await expect(enLista(page, titulo)).toHaveCount(0);
});

test("una respuesta que se cortó al cerrar la app se ve como interrumpida, sin propuestas pendientes", async ({ page }) => {
  const s = await settings();
  await simularRutas(page, {
    "/settings": s,
    "/conversations": [{ id: "cortada1", titulo: "Sube el vídeo", perfil: s.profile, creada: 1, actualizada: 1 }],
    "/conversations/cortada1": {
      id: "cortada1",
      titulo: "Sube el vídeo",
      perfil: s.profile,
      creada: 1,
      actualizada: 1,
      turnos: [
        {
          texto: "Sube el vídeo",
          eventos: [
            { type: "tool_use", id: "t1", name: "youtube_upload_video", input: { file_path: "C:\\Videos\\a.mp4" } },
            { type: "approval_required", approval: { id: "ap1", tool: "youtube_upload_video", args: { file_path: "C:\\Videos\\a.mp4" }, risk: "write", quota: { bucket: "video_insert", cost: 1 }, status: "pending", created_at: 1 } },
          ],
        },
      ],
    },
  });
  await page.goto("/#/chat");
  await enLista(page, "Sube el vídeo").click();
  await expect(page.getByTestId("turno-error")).toContainText("La respuesta se interrumpió antes de terminar");
  await expect(page.getByRole("button", { name: "Aprobar" })).toHaveCount(0);
});

test.describe("chats por canal (sidecar simulado)", () => {
  const CHATS = [
    { id: "delcanala", titulo: "Chat del canal A", perfil: "default", creada: 1, actualizada: 1 },
    { id: "delcanalb", titulo: "Chat del canal B", perfil: "smooth", creada: 2, actualizada: 2 },
  ];

  test("la lista muestra los chats del canal en uso y cambia al usar otro canal", async ({ page }) => {
    const estado = { ...(await settings()), profile: "default", has_client_secret: true };
    await simularRutas(page, {
      "/settings": (_u, p) => {
        if (p.metodo === "PUT") Object.assign(estado, p.cuerpo as object);
        return [200, estado];
      },
      "/youtube/status": () => [200, { auth: { profile: estado.profile, profiles: ["default", "smooth"], authenticated: true, store: "x" }, quota: { buckets: { general: { used: 1, limit: 10000 }, search: { used: 0, limit: 100 }, video_insert: { used: 0, limit: 100 } } } }],
      "/conversations": CHATS,
      "/conversations/delcanala": { ...CHATS[0], turnos: [{ texto: "hola A", eventos: [{ type: "done", conversation_id: "delcanala", stop_reason: "end_turn", usage: null }] }] },
    });
    await page.goto("/#/chat");
    await expect(enLista(page, "Chat del canal A")).toBeVisible();
    await expect(enLista(page, "Chat del canal B")).toHaveCount(0);
    await enLista(page, "Chat del canal A").click();
    await expect(page.getByTestId("msg-user")).toHaveText("hola A");

    await page.getByTestId("nav-ajustes").click();
    await page.getByTestId("ajustes-yt-usar-smooth").click();
    await expect(page.getByTestId("ajustes-profile-smooth")).toHaveAttribute("aria-current", "true");
    await expect(enLista(page, "Chat del canal B")).toBeVisible();
    await expect(enLista(page, "Chat del canal A")).toHaveCount(0);
    // El chat abierto era del canal A: cambiar de canal deja abierto un chat vacío.
    await page.getByTestId("nav-chat").click();
    await expect(page.getByTestId("conv-chat:1")).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("chat-vacio")).toBeVisible();
  });

  test("borrar el chat nuevo nunca abre un chat de otro canal", async ({ page }) => {
    const estado = { ...(await settings()), profile: "default", has_client_secret: true };
    const borrados: string[] = [];
    await simularRutas(page, {
      "/settings": estado,
      "/youtube/status": { auth: { profile: "default", profiles: ["default", "smooth"], authenticated: true, store: "x" }, quota: { buckets: { general: { used: 1, limit: 10000 }, search: { used: 0, limit: 100 }, video_insert: { used: 0, limit: 100 } } } },
      "/conversations": CHATS,
      "/conversations/delcanala": (_u, p) => {
        if (p.metodo === "DELETE") borrados.push("delcanala");
        return [200, p.metodo === "DELETE" ? { borrada: "delcanala" } : { ...CHATS[0], turnos: [{ texto: "hola A", eventos: [{ type: "done", conversation_id: "delcanala", stop_reason: "end_turn", usage: null }] }] }];
      },
      "/conversations/delcanalb": { ...CHATS[1], turnos: [{ texto: "hola B", eventos: [{ type: "done", conversation_id: "delcanalb", stop_reason: "end_turn", usage: null }] }] },
    });
    const borrar = async (nombre: string) => {
      await page.getByTestId("nav-conversaciones").getByRole("button", { name: `Borrar la conversación «${nombre}»` }).click();
      await page.getByRole("dialog", { name: "¿Borrar la conversación?" }).getByRole("button", { name: "Borrar" }).click();
    };
    await page.goto("/#/chat");
    await enLista(page, "Chat del canal A").click();
    await expect(page.getByTestId("msg-user")).toHaveText("hola A");
    await borrar("Chat del canal A");
    await expect(enLista(page, "Chat del canal A")).toHaveCount(0);
    await borrar("Nueva conversación");
    await page.getByTestId("nav-ajustes").click();
    await page.getByTestId("nav-chat").click();
    // Queda un chat vacío del canal en uso, no el del canal B (que ni siquiera está en la lista).
    await expect(page.getByTestId("chat-vacio")).toBeVisible();
    await expect(page.getByTestId("msg-user")).toHaveCount(0);
    await expect(enLista(page, "Chat del canal B")).toHaveCount(0);
    expect(borrados).toEqual(["delcanala"]);
  });
});
