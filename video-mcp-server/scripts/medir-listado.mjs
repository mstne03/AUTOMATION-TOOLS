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

function medir(nombre, extraEnv, prefijo = "", dirFijo) {
  const dir = dirFijo ?? fs.mkdtempSync(path.join(os.tmpdir(), "medir "));
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
// Ronda 5: en la ronda 4 el cuarto con PSModuleAnalysisCachePath bajó a 0,38 s. Se confirma y se prueban
// arreglos: caché propia en una carpeta estable (dos llamadas, la 2.ª debería reutilizarla) y no depender
// del análisis de módulos (autocarga desactivada e Import-Module por ruta completa).
const CIM = path.join(MODULOS, "CimCmdlets", "CimCmdlets.psd1");
const UTIL = path.join(MODULOS, "Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Utility.psd1");
const sinAutocarga =`$PSModuleAutoloadingPreference = 'None'\nImport-Module '${CIM}'\nImport-Module '${UTIL}'\n`;
const estable = fs.mkdtempSync(path.join(os.tmpdir(), "medir estable "));
const cacheEstable = (d) => ({ PSModuleAnalysisCachePath: path.join(d, "ModuleAnalysisCache") });
const estable2 = fs.mkdtempSync(path.join(os.tmpdir(), "medir estable2 "));
const RONDA = [
  ["A referencia (hoy)", () => ({}), "", undefined],
  ["R1 + PSModuleAnalysisCachePath del runner", de("PSModuleAnalysisCachePath"), "", undefined],
  ["R2 caché propia estable #1", cacheEstable, "", estable],
  ["R2 caché propia estable #2", cacheEstable, "", estable],
  ["R2 caché propia estable #3", cacheEstable, "", estable],
  ["R3 sin autocarga + Import por ruta #1", () => ({}), sinAutocarga, undefined],
  ["R3 sin autocarga + Import por ruta #2", () => ({}), sinAutocarga, undefined],
  ["R4 = R2 + R3 #1", cacheEstable, sinAutocarga, estable2],
  ["R4 = R2 + R3 #2", cacheEstable, sinAutocarga, estable2],
  ["K entorno completo (control)", () => ({ ...process.env }), "", undefined],
];
for (const [nombre, extra, prefijo, dir] of RONDA) await medir(nombre, extra, prefijo, dir);
