// Arnés de comparación (SEO-111): lectura del SSIM, veredicto por mínimo, entorno cerrado de la CLI y servidor de la
// sonda de preview (solo loopback, clave de capacidad, sin salir de la composición).
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { entornoCerrado, leerSsim, veredicto } from "../scripts/comparar-fotogramas.mjs";
import { servirComposicion } from "../scripts/sondear-preview.mjs";
import { MARCADOR_SALIDA, prepararSalida } from "../scripts/montar.mjs";

const ENTORNO = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ENTORNO)) delete process.env[k];
  Object.assign(process.env, ENTORNO);
});

describe("comparar-fotogramas", () => {
  it("lee el log de ssim de ffmpeg", () => {
    expect(leerSsim("n:1 Y:0.99 U:0.99 V:0.99 All:0.995000 (23.0)\nn:2 Y:1 U:1 V:1 All:0.980000 (17.0)\n")).toEqual([
      { n: 1, ssim: 0.995 },
      { n: 2, ssim: 0.98 },
    ]);
  });

  it("el veredicto falla si un solo fotograma baja del umbral", () => {
    const v = veredicto([{ n: 1, ssim: 0.999 }, { n: 31, ssim: 0.989 }], 0.99);
    expect(v).toMatchObject({ fotogramas: 2, bajoUmbral: 1, ok: false, ssimMin: 0.989 });
    expect(v.peores[0]).toEqual({ t: 1, ssim: 0.989 }); // t = (n-1)/30
  });

  it("sin fotogramas el veredicto no es ok", () => {
    expect(veredicto([], 0.99).ok).toBe(false);
  });

  it("el entorno de la CLI es una lista blanca con el modo cerrado (I5, I13)", () => {
    process.env.ELEVENLABS_API_KEY = "sk-centinela";
    const env = entornoCerrado("C:\\motor", "C:\\home");
    expect(Object.keys(env).sort()).toEqual([
      "CI",
      "DO_NOT_TRACK",
      "FFMPEG_DIR",
      "HOME",
      "HYPERFRAMES_BROWSER_PATH",
      "HYPERFRAMES_NO_AUTO_INSTALL",
      "HYPERFRAMES_NO_OPTIONAL_INSTALL",
      "HYPERFRAMES_NO_TELEMETRY",
      "HYPERFRAMES_NO_UPDATE_CHECK",
      "HYPERFRAMES_SKIP_SKILLS",
      "PATH",
      "SYSTEMROOT",
      "TEMP",
      "TMP",
      "USERPROFILE",
    ]);
    expect(JSON.stringify(env)).not.toContain("sk-centinela");
    expect(env.HOME).toBe("C:\\home");
    expect(env.HYPERFRAMES_BROWSER_PATH).toBe(path.join("C:\\motor", "browser", "chrome-headless-shell-win64", "chrome-headless-shell.exe"));
  });
});

describe("servidor de la sonda de preview (L4)", () => {
  function pedir(puerto: number, ruta: string, host = `127.0.0.1:${puerto}`, metodo = "GET") {
    return new Promise<{ codigo: number; cabeceras: http.IncomingHttpHeaders; cuerpo: string }>((ok, mal) => {
      const req = http.request({ host: "127.0.0.1", port: puerto, path: ruta, method: metodo, headers: { Host: host } }, (res) => {
        let cuerpo = "";
        res.on("data", (d) => (cuerpo += d));
        res.on("end", () => ok({ codigo: res.statusCode!, cabeceras: res.headers, cuerpo }));
      });
      req.on("error", mal);
      req.end();
    });
  }

  it("solo sirve la composición bajo la clave de capacidad, con Host exacto y sin salir de la raíz", async () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "arnes-"));
    fs.writeFileSync(path.join(path.dirname(raiz), `${path.basename(raiz)}-secreto.txt`), "secreto");
    const politica = "default-src 'none'; script-src 'self'";
    fs.writeFileSync(
      path.join(raiz, "index.html"),
      `<!doctype html><html><head><meta charset="UTF-8" />\n<meta http-equiv="Content-Security-Policy" content="${politica}" />\n<title>x</title></head><body></body></html>`,
    );
    const s = await servirComposicion({ dir: raiz });
    try {
      const clave = s.base.split("/")[3];
      expect(clave).toMatch(/^[0-9a-f]{64}$/);
      const ok = await pedir(s.puerto, `/${clave}/index.html`);
      expect(ok.codigo).toBe(200);
      // El runtime va justo después del <meta> de la CSP (M3).
      expect(ok.cuerpo).toMatch(/content="[^"]+" \/>\n?<script src="\/[0-9a-f]{64}\/__runtime\.js"><\/script>/);
      expect(ok.cabeceras["content-security-policy"]).toBe(`default-src 'none'; script-src http://127.0.0.1:${s.puerto}; sandbox allow-scripts`);
      expect(ok.cabeceras["x-content-type-options"]).toBe("nosniff");
      expect((await pedir(s.puerto, "/index.html")).codigo).toBe(404);
      expect((await pedir(s.puerto, `/${"0".repeat(64)}/index.html`)).codigo).toBe(404);
      expect((await pedir(s.puerto, `/${clave}/index.html`, `localhost:${s.puerto}`)).codigo).toBe(421);
      expect((await pedir(s.puerto, `/${clave}/index.html`, "127.0.0.1")).codigo).toBe(421);
      expect((await pedir(s.puerto, `/${clave}/index.html`, undefined, "POST")).codigo).toBe(405);
      const fuera = `${path.basename(raiz)}-secreto.txt`;
      expect((await pedir(s.puerto, `/${clave}/..%2F${fuera}`)).codigo).toBe(404);
      expect((await pedir(s.puerto, `/${clave}/%2e%2e%5c${fuera}`)).codigo).toBe(404);
      expect((await pedir(s.puerto, `/${clave}/index.html%00`)).codigo).toBe(404);
      const marco = await pedir(s.puerto, `/${clave}/__marco.html`);
      expect(marco.cuerpo).toContain(`<iframe sandbox="allow-scripts" src="/${clave}/index.html" `);
      expect(marco.cabeceras["content-security-policy"]).toBe(`default-src 'none'; frame-src http://127.0.0.1:${s.puerto}`);
    } finally {
      await s.cerrar();
    }
  });

  it("sin CSP (control positivo) quita el <meta> y no envía la cabecera", async () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "arnes-"));
    fs.writeFileSync(
      path.join(raiz, "index.html"),
      `<!doctype html><html><head><meta charset="UTF-8" />\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'" />\n</head><body></body></html>`,
    );
    const s = await servirComposicion({ dir: raiz, sinCsp: true, marcoSinCsp: true });
    try {
      const clave = s.base.split("/")[3];
      const r = await pedir(s.puerto, `/${clave}/index.html`);
      expect(r.cuerpo).not.toContain("Content-Security-Policy");
      expect(r.cabeceras["content-security-policy"]).toBeUndefined();
      expect((await pedir(s.puerto, `/${clave}/__marco.html`)).cabeceras["content-security-policy"]).toBeUndefined();
    } finally {
      await s.cerrar();
    }
  });

  it("reescribirMeta cambia 'self' por el origen exacto en el <meta>, nunca por * (M1)", async () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "arnes-"));
    fs.writeFileSync(
      path.join(raiz, "index.html"),
      `<!doctype html><html><head><meta charset="UTF-8" />\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'self'" />\n<meta http-equiv="x-dns-prefetch-control" content="off" />\n</head><body></body></html>`,
    );
    const s = await servirComposicion({ dir: raiz, reescribirMeta: true, sinDnsPrefetchOff: true });
    try {
      const r = await pedir(s.puerto, `/${s.base.split("/")[3]}/index.html`);
      const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(r.cuerpo)![1];
      expect(meta).toBe(`default-src 'none'; script-src ${s.origen} 'unsafe-inline'; connect-src ${s.origen}`);
      expect(meta).not.toMatch(/\*|'self'/);
      expect(s.origen).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // sinDnsPrefetchOff (control de la sonda de dns-prefetch) quita solo ese <meta>.
      expect(r.cuerpo).not.toContain("x-dns-prefetch-control");
    } finally {
      await s.cerrar();
    }
  });
});

describe("montar: salida (LOW-10)", () => {
  it("se niega a borrar una carpeta ajena con contenido y sí borra la suya", () => {
    const ajena = fs.mkdtempSync(path.join(os.tmpdir(), "arnes-ajena-"));
    fs.writeFileSync(path.join(ajena, "importante.txt"), "no borrar");
    expect(() => prepararSalida(ajena)).toThrow(/no la creó el arnés/);
    expect(fs.existsSync(path.join(ajena, "importante.txt"))).toBe(true);

    const propia = path.join(os.tmpdir(), `arnes-propia-${process.pid}-${Date.now()}`);
    prepararSalida(propia);
    expect(fs.existsSync(path.join(propia, MARCADOR_SALIDA))).toBe(true);
    fs.writeFileSync(path.join(propia, "viejo.txt"), "x");
    prepararSalida(propia);
    expect(fs.readdirSync(propia)).toEqual([MARCADOR_SALIDA]);
  });
});
