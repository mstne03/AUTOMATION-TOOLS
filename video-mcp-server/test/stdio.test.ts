// Arranca dist/index.js por stdio, llama a video_listar y video_estado y comprueba que stdout solo lleva JSON-RPC.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SERVIDOR = path.resolve(import.meta.dirname, "..", "dist", "index.js");
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), "video stdio "));
afterAll(() => fs.rmSync(RAIZ, { recursive: true, force: true }));

describe("servidor stdio", () => {
  it(
    "integrado y sin CfT, video_capacidades responde: sin chrome y con «Falta el navegador…» en el detalle (C3)",
    async () => {
      const estado = path.join(RAIZ, "video", "estado");
      const ff = path.join(RAIZ, "ffmpeg-falso");
      fs.mkdirSync(ff);
      for (const n of ["ffmpeg.exe", "ffprobe.exe"]) fs.writeFileSync(path.join(ff, n), ""); // existen; no se ejecutan bien
      const hijo = spawn(process.execPath, [SERVIDOR], {
        cwd: os.tmpdir(),
        env: {
          SYSTEMROOT: process.env.SYSTEMROOT,
          PATH: process.env.PATH,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          VIDEO_ENGINE_EMBEDDED: "1",
          FFMPEG_DIR: ff,
          VIDEO_ROOT: RAIZ,
          VIDEO_STATE_DIR: estado,
          HYPERFRAMES_BROWSER_PATH: path.join(RAIZ, "video", "navegador", "1", "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
          VIDEO_NAVEGADOR_MANIFIESTO: path.join(RAIZ, "video", "navegador", "1", "MANIFIESTO-SHA256.json"),
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      let buffer = "";
      const respuestas = new Map<number, any>();
      hijo.stdout.on("data", (d: Buffer) => {
        buffer += d.toString("utf8");
        for (const linea of buffer.split("\n").slice(0, -1)) if (linea.trim()) respuestas.set(JSON.parse(linea).id, JSON.parse(linea));
        buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
      });
      const esperar = async (id: number) => {
        for (let i = 0; i < 1200 && !respuestas.has(id); i++) await new Promise((r) => setTimeout(r, 50));
        expect(respuestas.has(id), `sin respuesta a ${id}`).toBe(true);
        return respuestas.get(id);
      };
      const enviar = (m: object) => hijo.stdin.write(JSON.stringify(m) + "\n");
      try {
        enviar({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
        await esperar(1);
        enviar({ jsonrpc: "2.0", method: "notifications/initialized" });
        enviar({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "video_capacidades", arguments: {} } });
        const r = await esperar(2);
        expect(r.result.isError, JSON.stringify(r.result)).toBeFalsy();
        const datos = JSON.parse(r.result.content.at(-1).text);
        expect(datos.chrome).toBeUndefined();
        expect(datos.gpu?.detalle).toMatch(/Falta el navegador/);
      } finally {
        hijo.kill();
      }
    },
    60000,
  );

  it(
    "sin_tools_antiguas_en_integrado: con VIDEO_ENGINE_EMBEDDED=1 solo quedan las tools nuevas del almacén",
    async () => {
      expect(fs.existsSync(SERVIDOR), "Ejecuta npm run build antes").toBe(true);
      const hijo = spawn(process.execPath, [SERVIDOR], {
        cwd: os.tmpdir(),
        env: {
          SYSTEMROOT: process.env.SYSTEMROOT,
          PATH: process.env.PATH,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          VIDEO_ENGINE_EMBEDDED: "1",
          VIDEO_ROOT: path.join(RAIZ, "integrado", "proyectos"),
          VIDEO_STATE_DIR: path.join(RAIZ, "integrado", "estado"),
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      let buffer = "";
      const respuestas = new Map<number, any>();
      hijo.stdout.on("data", (d: Buffer) => {
        buffer += d.toString("utf8");
        for (const linea of buffer.split("\n").slice(0, -1)) if (linea.trim()) respuestas.set(JSON.parse(linea).id, JSON.parse(linea));
        buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
      });
      const esperar = async (id: number) => {
        for (let i = 0; i < 1200 && !respuestas.has(id); i++) await new Promise((r) => setTimeout(r, 50));
        expect(respuestas.has(id), `sin respuesta a ${id}`).toBe(true);
        return respuestas.get(id);
      };
      const enviar = (m: object) => hijo.stdin.write(JSON.stringify(m) + "\n");
      try {
        enviar({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
        await esperar(1);
        enviar({ jsonrpc: "2.0", method: "notifications/initialized" });
        enviar({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        const nombres: string[] = (await esperar(2)).result.tools.map((t: { name: string }) => t.name);
        for (const vieja of ["video_guardar_guion", "video_generar_voz", "video_estado", "video_listar", "video_musica", "video_catalogo"]) {
          expect(nombres, vieja).not.toContain(vieja);
        }
        expect(nombres).toEqual(expect.arrayContaining(["video_guion_esquema", "video_guion_guardar", "video_proyecto_crear", "video_proyecto_guardar", "video_proyecto_leer"]));
        // Un error tipado llega como isError con el bloque JSON { codigo, problemas }.
        enviar({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "video_proyecto_leer", arguments: { id: "video1" } } });
        const r = await esperar(3);
        expect(r.result.isError).toBe(true);
        expect(JSON.parse(r.result.content.at(-1).text)).toEqual({ codigo: "esquema", problemas: [{ ruta: "id", codigo: "id_invalido" }] });
      } finally {
        hijo.kill();
      }
    },
    60000,
  );

  it(
    "responde a initialize, tools/list y tools/call con stdout limpio",
    async () => {
      expect(fs.existsSync(SERVIDOR), "Ejecuta npm run build antes").toBe(true);
      fs.mkdirSync(path.join(RAIZ, "video001"));
      fs.writeFileSync(path.join(RAIZ, "video001", "guion.md"), "---\ntitulo: T\n---\n[1] a");

      // cwd distinto del repo, como hace Claude Desktop.
      const hijo = spawn(process.execPath, [SERVIDOR], {
        cwd: os.tmpdir(),
        env: { ...process.env, VIDEO_ROOT: RAIZ },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      const respuestas = new Map<number, any>();
      hijo.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
        for (const linea of stdout.split("\n").slice(0, -1)) {
          if (!linea.trim()) continue;
          const msg = JSON.parse(linea); // falla si algo que no es JSON-RPC llega a stdout
          expect(msg.jsonrpc).toBe("2.0");
          if (msg.id !== undefined) respuestas.set(msg.id, msg);
        }
        stdout = stdout.slice(stdout.lastIndexOf("\n") + 1);
      });
      const enviar = (m: object) => hijo.stdin.write(JSON.stringify(m) + "\n");
      const esperar = async (id: number) => {
        for (let i = 0; i < 200 && !respuestas.has(id); i++) await new Promise((r) => setTimeout(r, 50));
        expect(respuestas.has(id), `sin respuesta a ${id}`).toBe(true);
        return respuestas.get(id);
      };

      enviar({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      const init = await esperar(1);
      expect(init.result.serverInfo.name).toBe("video");
      enviar({ jsonrpc: "2.0", method: "notifications/initialized" });

      enviar({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const lista = await esperar(2);
      expect(lista.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
        "video_ayuda",
        "video_barrer_procesos",
        "video_capacidades",
        "video_catalogo",
        "video_estado",
        "video_estado_render",
        "video_fotograma",
        "video_generar_voz",
        "video_guardar_guion",
        "video_guion_borrar",
        "video_guion_esquema",
        "video_guion_guardar",
        "video_guion_leer",
        "video_guion_listar",
        "video_listar",
        "video_montar_preview",
        "video_musica",
        "video_musica_importar",
        "video_musica_listar",
        "video_perfil_duplicar",
        "video_perfil_guardar",
        "video_perfiles_listar",
        "video_proyecto_crear",
        "video_proyecto_guardar",
        "video_proyecto_leer",
        "video_proyecto_listar",
        "video_recurso_borrar",
        "video_recurso_importar",
        "video_renderizar",
        "video_vista_previa",
        "video_voces",
        "video_voz_coste",
        "video_voz_forma",
        "video_voz_generar",
        "video_voz_muestra",
        "video_voz_quitar_silencios",
      ]);
      const guardar = lista.result.tools.find((t: { name: string }) => t.name === "video_guardar_guion");
      expect(guardar.description).toMatch(/video_ayuda/);
      expect(guardar.description).toMatch(/cortes_al_ritmo/);

      enviar({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "video_listar", arguments: {} } });
      const listar = await esperar(3);
      expect(listar.result.content[0].text).toMatch(/video001/);
      expect(listar.result.content[0].text).toMatch(/video002/);

      enviar({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "video_estado", arguments: { id: "video001" } } });
      const estado = await esperar(4);
      expect(estado.result.isError).toBeFalsy();
      expect(estado.result.content[0].text).toMatch(/Guion NO válido/);

      enviar({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "video_estado", arguments: { id: "../etc" } } });
      const malo = await esperar(5);
      expect(malo.result.isError).toBe(true);

      enviar({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "video_ayuda", arguments: {} } });
      const ayuda = await esperar(6);
      expect(ayuda.result.content[0].text).toMatch(/### titulo3d[\s\S]*## Ejemplo completo/);

      hijo.kill();
    },
    30000,
  );
});
