// W3.2 (I4): la carpeta del ffmpeg del bundle solo tiene ffmpeg y ffprobe; una DLL de más se rechaza.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { revisarCarpetaFfmpeg } from "../src/proceso.js";

const EXE = process.platform === "win32" ? ".exe" : "";
const tmps: string[] = [];
afterEach(() => tmps.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** Un bundle falso: <raiz>/app (SERVER_ROOT) y <raiz>/ffmpeg con los dos ejecutables. */
function bundle(): { app: string; ffmpeg: string } {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "carpeta-ffmpeg-"));
  tmps.push(raiz);
  const app = path.join(raiz, "app");
  const ffmpeg = path.join(raiz, "ffmpeg");
  fs.mkdirSync(app);
  fs.mkdirSync(ffmpeg);
  for (const f of ["ffmpeg", "ffprobe"]) fs.writeFileSync(path.join(ffmpeg, `${f}${EXE}`), "x");
  return { app, ffmpeg };
}

describe("revisarCarpetaFfmpeg", () => {
  it("acepta exactamente ffmpeg y ffprobe", () => {
    const b = bundle();
    expect(revisarCarpetaFfmpeg(b.ffmpeg, b.app)).toBeUndefined();
  });

  it("rechaza una DLL plantada junto al ffmpeg", () => {
    const b = bundle();
    fs.writeFileSync(path.join(b.ffmpeg, "nvEncodeAPI64.dll"), "x");
    expect(revisarCarpetaFfmpeg(b.ffmpeg, b.app)).toMatch(/nvencodeapi64\.dll|nvEncodeAPI64\.dll/);
  });

  it("rechaza una subcarpeta y un enlace duro", () => {
    const b = bundle();
    fs.mkdirSync(path.join(b.ffmpeg, "sub"));
    fs.writeFileSync(path.join(b.ffmpeg, "sub", "amfrt64.dll"), "x");
    expect(revisarCarpetaFfmpeg(b.ffmpeg, b.app)).toBeDefined();
    const c = bundle();
    fs.linkSync(path.join(c.ffmpeg, `ffmpeg${EXE}`), path.join(c.app, "copia"));
    expect(revisarCarpetaFfmpeg(c.ffmpeg, c.app)).toMatch(/enlace duro/);
  });

  it("no aplica fuera de la carpeta del bundle (desarrollo y E2E con el ffmpeg de winget)", () => {
    const b = bundle();
    fs.writeFileSync(path.join(b.ffmpeg, "ffplay.exe"), "x");
    expect(revisarCarpetaFfmpeg(b.ffmpeg, path.join(b.app, "otra"))).toBeUndefined();
  });
});
