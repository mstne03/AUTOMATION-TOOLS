// I5/I7 (HIGH-1 de la R0): ningún módulo lanza procesos por su cuenta; todo pasa por ejecutar() de
// proceso.ts, que pone el entorno por lista blanca, el timeout que mata el árbol y el barrido.
// I14: video_catalogo (red de HyperFrames) no existe en modo integrado.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../src/raiz.js";

const SRC = path.join(SERVER_ROOT, "src");
// Lista de excepciones vacía: ni siquiera fotograma.ts.
const EXCEPCIONES: string[] = [];
const ENTRADA_SEGURA = /(argsEntrada\(.*|-protocol_whitelist.*|"-f", "lavfi", )"-i"/;
const PROHIBIDO = /child_process|\bspawn(Sync)?\(|\bexecFile(Sync)?\b|(?<![.\w])exec(Sync)?\(/;

function ficheros(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? ficheros(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : [],
  );
}

describe("procesos solo desde proceso.ts", () => {
  it("ningún fichero de src/ fuera de proceso.ts usa child_process, spawn, execFile ni exec", () => {
    const culpables = ficheros(SRC)
      .filter((f) => path.basename(f) !== "proceso.ts" && !EXCEPCIONES.includes(path.basename(f)))
      .flatMap((f) =>
        fs
          .readFileSync(f, "utf8")
          .split(/\r?\n/)
          .map((l, i) => ({ l, i }))
          .filter(({ l }) => PROHIBIDO.test(l))
          .map(({ i }) => `${path.relative(SRC, f)}:${i + 1}`),
      );
    expect(culpables).toEqual([]);
  });

  it("I15: todo \"-i\" de src/ lleva argsEntrada o -protocol_whitelist antes; la única excepción es -f lavfi", () => {
    const malas = ficheros(SRC).flatMap((f) =>
      fs
        .readFileSync(f, "utf8")
        .split(/\r?\n/)
        .flatMap((l, i) => (l.includes('"-i"') && !ENTRADA_SEGURA.test(l) ? [`${path.relative(SRC, f)}:${i + 1}`] : [])),
    );
    expect(malas).toEqual([]);
  });

  it("el patrón de entradas no da por buena una entrada sin protección", () => {
    expect(ENTRADA_SEGURA.test('["-y", "-i", origen]')).toBe(false);
    expect(ENTRADA_SEGURA.test('["-i", origen, "-protocol_whitelist", "file"]')).toBe(false);
    expect(ENTRADA_SEGURA.test('["-f", "lavfi", "-i", "color"]')).toBe(true);
    expect(ENTRADA_SEGURA.test('[...argsEntrada(a), "-i", a]')).toBe(true);
  });

  it("el patrón detecta lo que tiene que detectar (y no RegExp.exec)", () => {
    for (const l of ['import { spawn } from "node:child_process";', "spawn(x)", "execFile(x)", "exec(x)", "execSync(x)"]) expect(PROHIBIDO.test(l)).toBe(true);
    expect(PROHIBIDO.test("const m = /a/.exec(texto);")).toBe(false);
  });
});

describe("tools/list en modo integrado", () => {
  it("video_catalogo no se registra en integrado (I14) y sí fuera", async () => {
    const nombres = async (integrado: boolean): Promise<string[]> => {
      const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "video tools "));
      const env: NodeJS.ProcessEnv = { ...process.env, VIDEO_ROOT: raiz, VIDEO_STATE_DIR: path.join(raiz, "estado") };
      if (integrado) env.VIDEO_ENGINE_EMBEDDED = "1";
      else delete env.VIDEO_ENGINE_EMBEDDED;
      // Lanza dist/: `npm test` lo compila antes; con `vitest` suelto, un dist/ obsoleto daría un resultado falso.
      const hijo = spawn(process.execPath, [path.join(SERVER_ROOT, "dist", "index.js")], { env, stdio: ["pipe", "pipe", "ignore"] });
      try {
        let buf = "";
        const respuesta = (id: number) =>
          new Promise<{ result: { tools: { name: string }[] } }>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("sin respuesta")), 20000);
            hijo.stdout.on("data", (d: Buffer) => {
              buf += d.toString("utf8");
              for (const l of buf.split("\n")) {
                try {
                  const m = JSON.parse(l);
                  if (m.id === id) {
                    clearTimeout(t);
                    resolve(m);
                  }
                } catch {
                  /* línea incompleta */
                }
              }
            });
          });
        const enviar = (m: object) => hijo.stdin.write(JSON.stringify(m) + "\n");
        enviar({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
        await respuesta(1);
        enviar({ jsonrpc: "2.0", method: "notifications/initialized" });
        enviar({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        return (await respuesta(2)).result.tools.map((t) => t.name);
      } finally {
        hijo.kill();
        fs.rmSync(raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    };
    expect(await nombres(true)).not.toContain("video_catalogo");
    const sueltos = await nombres(false);
    expect(sueltos).toContain("video_catalogo");
    expect(sueltos).toContain("video_renderizar");
  }, 60000);
});
