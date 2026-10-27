/** Arranca el sidecar REAL (APP_BACKEND_SECRETS=file, directorio temporal, token fijo) apuntando
 *  a un Anthropic falso, y Vite en el puerto 1420 (el único origen de desarrollo admitido por el CORS del sidecar) con las variables VITE_SIDECAR_*. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startAnthropicMock } from "./anthropic-mock";

export const TOKEN = "e2e-token-playwright";
export const VITE_PORT = 1420;
const ESTADO = join(tmpdir(), "seo-studio-e2e-pids.json");
const PREFIJO = "seo-studio-e2e-";
const DIA_MS = 24 * 60 * 60 * 1000;

/** Borra los directorios de estado de más de 24 h que dejaron ejecuciones interrumpidas (cada uno
 *  pesa ~470 MB: snapshot de la KB + modelo de embeddings). Los recientes se respetan por si hay
 *  otra ejecución en curso. */
function limpiarEstadosHuerfanos() {
  for (const nombre of readdirSync(tmpdir())) {
    if (!nombre.startsWith(PREFIJO)) continue;
    const ruta = join(tmpdir(), nombre);
    try {
      const st = statSync(ruta);
      if (st.isDirectory() && Date.now() - st.mtimeMs > DIA_MS) rmSync(ruta, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[e2e] No se pudo borrar ${ruta}: ${(e as Error).message}`);
    }
  }
}

function esperarPuerto(url: string, ms: number, init?: RequestInit): Promise<void> {
  const fin = Date.now() + ms;
  return new Promise((ok, ko) => {
    const intento = () =>
      fetch(url, init)
        .then((r) => (r.status < 500 ? ok() : reintentar()))
        .catch(reintentar);
    const reintentar = () => (Date.now() > fin ? ko(new Error(`Sin respuesta en ${url}`)) : setTimeout(intento, 500));
    intento();
  });
}

export default async function globalSetup() {
  const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  limpiarEstadosHuerfanos();
  const stateDir = mkdtempSync(join(tmpdir(), PREFIJO));
  // Se anota ya, antes de arrancar nada, para que el teardown lo borre aunque el setup falle después.
  writeFileSync(ESTADO, JSON.stringify({ stateDir }));
  const mock = await startAnthropicMock();

  const sidecar: ChildProcess = spawn("uv", ["run", "app-backend"], {
    cwd: resolve(raiz, "..", "app-backend"),
    env: {
      ...process.env,
      APP_BACKEND_SECRETS: "file",
      APP_BACKEND_DIR: stateDir,
      APP_BACKEND_TOKEN: TOKEN,
      ANTHROPIC_BASE_URL: mock.url,
    },
    shell: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise<number>((ok, ko) => {
    let buf = "";
    sidecar.stdout!.on("data", (d) => {
      buf += d;
      const linea = buf.split("\n")[0];
      if (linea.includes('"port"')) ok(JSON.parse(linea).port as number);
    });
    sidecar.on("exit", (c) => ko(new Error(`El sidecar terminó con código ${c}`)));
    setTimeout(() => ko(new Error("El sidecar no anunció el puerto en 60 s")), 60_000);
  });
  const base = `http://127.0.0.1:${port}`;
  await esperarPuerto(`${base}/settings`, 60_000, { headers: { Authorization: `Bearer ${TOKEN}` } });
  // Clave de prueba en el almacén `file`: el chat exige una, y el Anthropic falso no la mira.
  await fetch(`${base}/settings`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ anthropic_api_key: "sk-ant-e2e-falsa", allowed_dirs: [{ path: "C:\\Users\\Marc\\Videos", language: "es" }] }),
  });

  // Si ya hay algo en 1420 (un `tauri dev` o `pnpm dev` abierto), los tests hablarían con OTRO
  // sidecar, quizá el real con credenciales de verdad. Abortar es la única opción segura.
  const ocupado = await fetch(`http://localhost:${VITE_PORT}/`).then(() => true).catch(() => false);
  if (ocupado) throw new Error(`El puerto ${VITE_PORT} ya está en uso: cierra tauri dev / pnpm dev antes de los E2E.`);

  const vite: ChildProcess = spawn("pnpm", ["exec", "vite", "--port", String(VITE_PORT), "--strictPort"], {
    cwd: raiz,
    env: { ...process.env, VITE_SIDECAR_PORT: String(port), VITE_SIDECAR_TOKEN: TOKEN },
    shell: true,
    stdio: "ignore",
  });
  await esperarPuerto(`http://localhost:${VITE_PORT}/`, 60_000);

  process.env.E2E_SIDECAR = base;
  process.env.E2E_TOKEN = TOKEN;
  process.env.E2E_STATE_DIR = stateDir;
  writeFileSync(ESTADO, JSON.stringify({ stateDir, sidecar: sidecar.pid, vite: vite.pid }));
  (globalThis as { __e2e?: unknown }).__e2e = { mock: mock.server, sidecar, vite };
}

export { ESTADO };
