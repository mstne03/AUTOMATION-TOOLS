// Spike: lanza el navegador con o sin --no-sandbox, abre una página y lee con PowerShell la línea de comandos y el
// nivel de integridad de sus procesos renderer. Con sandbox, el renderer de Chromium en Windows corre con token
// restringido y nivel de integridad «Untrusted»; sin sandbox, con el del usuario («Medium»).
// Uso: node spikes/chromium/sandbox-renderer.mjs <navegador.exe> [--no-sandbox]
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const [exe, flag] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: exe, headless: true, args: flag ? [flag] : [] });
try {
  const p = await b.newPage();
  await p.setContent("<p>hola</p>");
  const pid = b.process().pid;
  // Hijos renderer del navegador: línea de comandos (CIM) y nivel de integridad de su token, que .NET no expone:
  // se lee con GetTokenInformation(TokenIntegrityLevel) desde un Add-Type mínimo.
  const ps = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class IL {
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, uint a, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr t, int c, IntPtr i, int l, out int r);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr s, uint n);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr s);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool h, int pid);
  public static int Nivel(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid); IntPtr t;
    if (h == IntPtr.Zero || !OpenProcessToken(h, 0x8, out t)) return -1;
    int r; GetTokenInformation(t, 25, IntPtr.Zero, 0, out r); IntPtr b = Marshal.AllocHGlobal(r);
    if (!GetTokenInformation(t, 25, b, r, out r)) return -2;
    IntPtr sid = Marshal.ReadIntPtr(b); int n = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
    return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(n - 1)));
  }
}
"@
Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Where-Object { $_.CommandLine -match 'type=renderer' } | ForEach-Object {
  $n = [IL]::Nivel([int]$_.ProcessId)
  $nombre = switch ($n) { 0 {'Untrusted'} 4096 {'Low'} 8192 {'Medium'} 12288 {'High'} default {"$n"} }
  "renderer pid=$($_.ProcessId) integridad=$nombre no-sandbox=$($_.CommandLine -match '--no-sandbox')"
}`;
  console.log(execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim() || "sin renderer visible");
} finally {
  await b.close();
}
