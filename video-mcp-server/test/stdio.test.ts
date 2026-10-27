// Arranca dist/index.js por stdio, llama a footy_listar y footy_estado y comprueba que stdout solo lleva JSON-RPC.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SERVIDOR = path.resolve(import.meta.dirname, "..", "dist", "index.js");
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), "footy stdio "));
afterAll(() => fs.rmSync(RAIZ, { recursive: true, force: true }));

describe("servidor stdio", () => {
  it(
    "responde a initialize, tools/list y tools/call con stdout limpio",
    async () => {
      expect(fs.existsSync(SERVIDOR), "Ejecuta npm run build antes").toBe(true);
      fs.mkdirSync(path.join(RAIZ, "footy001"));
      fs.writeFileSync(path.join(RAIZ, "footy001", "guion.md"), "---\ntitulo: T\n---\n[1] a");

      // cwd distinto del repo, como hace Claude Desktop.
      const hijo = spawn(process.execPath, [SERVIDOR], {
        cwd: os.tmpdir(),
        env: { ...process.env, FOOTY_ROOT: RAIZ },
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
      expect(init.result.serverInfo.name).toBe("footy");
      enviar({ jsonrpc: "2.0", method: "notifications/initialized" });

      enviar({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const lista = await esperar(2);
      expect(lista.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
        "footy_ayuda",
        "footy_capacidades",
        "footy_catalogo",
        "footy_estado",
        "footy_estado_render",
        "footy_fotograma",
        "footy_generar_voz",
        "footy_guardar_guion",
        "footy_listar",
        "footy_musica",
        "footy_renderizar",
        "footy_vista_previa",
      ]);
      const guardar = lista.result.tools.find((t: { name: string }) => t.name === "footy_guardar_guion");
      expect(guardar.description).toMatch(/footy_ayuda/);
      expect(guardar.description).toMatch(/cortes_al_ritmo/);

      enviar({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "footy_listar", arguments: {} } });
      const listar = await esperar(3);
      expect(listar.result.content[0].text).toMatch(/footy001/);
      expect(listar.result.content[0].text).toMatch(/footy002/);

      enviar({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "footy_estado", arguments: { id: "footy001" } } });
      const estado = await esperar(4);
      expect(estado.result.isError).toBeFalsy();
      expect(estado.result.content[0].text).toMatch(/Guion NO válido/);

      enviar({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "footy_estado", arguments: { id: "../etc" } } });
      const malo = await esperar(5);
      expect(malo.result.isError).toBe(true);

      enviar({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "footy_ayuda", arguments: {} } });
      const ayuda = await esperar(6);
      expect(ayuda.result.content[0].text).toMatch(/### titulo3d[\s\S]*## Ejemplo completo/);

      hijo.kill();
    },
    30000,
  );
});
