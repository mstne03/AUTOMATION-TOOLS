// literalPowerShell: ninguna comilla cierra el literal, tampoco las tipográficas ‘ ’ ‚ ‛, que PowerShell acepta como
// comilla simple (revisión post-R2, Low-1: `'a’; Write-Output INYECTADO; #'` ejecutaba INYECTADO).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { literalPowerShell } from "../src/proceso.js";

const ps = path.join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const ejecutar = (script: string) =>
  execFileSync(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`, "utf16le").toString("base64")])
    .toString("utf8")
    .trim();

describe.runIf(process.platform === "win32")("literalPowerShell", () => {
  it.each(["C:\\Windows\\System32", "a'b", "a’; Write-Output INYECTADO; #", "‘‚‛’'", "C:\\Users\\O’Neil\\x"])("%s llega intacto", (s) => {
    expect(ejecutar(`Write-Output ${literalPowerShell(s)}`)).toBe(s);
  });

  it("control: sin escapar, ’ cierra el literal e inyecta", () => {
    expect(ejecutar(`Write-Output 'a’; Write-Output INYECTADO; #'`)).toContain("INYECTADO");
  });
});
