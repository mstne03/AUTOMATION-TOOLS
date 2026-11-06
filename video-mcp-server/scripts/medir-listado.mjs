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

const VARIANTES = [
  ["B Import-Module CimCmdlets", () => ({}), "Import-Module CimCmdlets\n"],
  ["C PSModulePath = módulos del sistema", () => ({ PSModulePath: MODULOS }), ""],
  ["D LOCALAPPDATA en su carpeta", (d) => ({ LOCALAPPDATA: path.join(d, "LocalAppData") }), ""],
  ["F C + D", (d) => ({ PSModulePath: MODULOS, LOCALAPPDATA: path.join(d, "LocalAppData") }), ""],
  ["A referencia (hoy)", () => ({}), ""],
];
for (const [nombre, extra, prefijo] of VARIANTES) for (const vez of [1, 2]) await medir(`${nombre} #${vez}`, extra, prefijo);
