// Diagnóstico temporal (SEO-109): por qué el listado de procesos del barrido tarda >30 s en un runner nuevo.
// Lanza el mismo Windows PowerShell 5.1 y la misma consulta que `listarProcesos`, con el entorno de
// `entornoHijo()` y variantes, cada una en una carpeta nueva (como hf-home). Uso: node scripts/medir-listado.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { entornoHijo, system32 } = await import("../dist/proceso.js");
const ps = path.join(system32(), "WindowsPowerShell", "v1.0", "powershell.exe");
const CONSULTA =
  "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = [int]$_.ProcessId; r = [string]$_.ExecutablePath } } | ConvertTo-Json -Compress";
const MODULOS = path.join(system32(), "WindowsPowerShell", "v1.0", "Modules");

function medir(nombre, extraEnv, prefijo = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "medir "));
  const env = { ...entornoHijo(), HOME: dir, USERPROFILE: dir, ...extraEnv(dir) };
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${prefijo}${CONSULTA}`;
  const cod = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((ok) => {
    const t = Date.now();
    const h = spawn(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", cod], { cwd: dir, env, windowsHide: true });
    let sal = 0;
    h.stdout.on("data", (b) => (sal += b.length));
    const reloj = setTimeout(() => h.kill(), 90_000);
    h.on("close", (code) => {
      clearTimeout(reloj);
      const cache = fs.readdirSync(dir, { recursive: true }).filter((f) => /ModuleAnalysisCache|StartupProfileData/i.test(String(f)));
      console.log(`${nombre.padEnd(34)} ${String(Date.now() - t).padStart(6)} ms  código ${code}  ${sal} B  caché en cwd: ${cache.join(", ") || "-"}`);
      ok();
    });
  });
}

const de = (...ks) => () => Object.fromEntries(ks.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
// Ronda 3: PATH y PSModulePath por separado, y bisección de todas las variables que el entorno mínimo quita.
const minimo = entornoHijo();
const faltan = Object.keys(process.env).filter((k) => !(k in minimo) && !["PATH", "Path", "PSModulePath"].includes(k)).sort();
// Ronda 4: la variable está en la 2.ª mitad (ronda 3: 0,36 s frente a 13 s). SystemDrive sola y cuartos de esa mitad.
const segunda = faltan.slice(Math.ceil(faltan.length / 2));
const q = Math.ceil(segunda.length / 4);
const cuartos = [0, 1, 2, 3].map((n) => segunda.slice(n * q, (n + 1) * q));
const VARIANTES = [
  ["A referencia (hoy)", () => ({}), ""],
  ["S + SystemDrive", de("SystemDrive"), ""],
  ...cuartos.map((c, n) => [`Q${n + 1} + ${c.length} vars (${c[0]}..${c.at(-1)})`, de(...c), ""]),
  ["K entorno completo (control)", () => ({ ...process.env }), ""],
];
for (const [nombre, extra, prefijo] of VARIANTES) await medir(nombre, extra, prefijo);
cuartos.forEach((c, n) => console.log(`Q${n + 1}:`, c.join(" ")));
