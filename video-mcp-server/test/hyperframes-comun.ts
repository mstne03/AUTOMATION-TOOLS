// Constantes y ayudantes compartidos por los tests del parche de HyperFrames (SEO-109):
// parche-hyperframes.test.ts (rápido, npm test) y sandbox-render.test.ts (pesado, render:sandbox).
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SERVER_ROOT } from "../src/raiz.js";

export const HF = path.join(SERVER_ROOT, "node_modules", "hyperframes");
export const DIST = path.join(HF, "dist");
export const PARCHE = path.join(SERVER_ROOT, "patches", "hyperframes+0.8.206.patch");
export const HASHES = path.join(SERVER_ROOT, "patches", "hyperframes+0.8.206.sha256.json");

/** Los flags que el parche (hunk A) añade en Windows a todo lanzamiento de Chrome. */
export const PROXY_NULO = "--proxy-server=127.0.0.1:1";
export const BYPASS = "--proxy-bypass-list=<-loopback>;localhost;127.0.0.1;[::1]";
export const RESOLVER = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1";
export const WEBRTC = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";
export const QUIC = "--disable-quic";
export const SIN_DECODIFICADOR = "--disable-accelerated-video-decode";
export const GPU_SIN_SANDBOX = "--disable-gpu-sandbox";
export const MARCADOR = "--hyperframes-owned-browser";
/** Los que van en todo lanzamiento en Windows (red cerrada y sin decodificación de vídeo por GPU). */
export const FLAGS_RED = [PROXY_NULO, BYPASS, RESOLVER, WEBRTC, QUIC, SIN_DECODIFICADOR];

/** URL importable de un chunk del dist (el `exports` del paquete no los expone). */
export const chunk = (nombre: string): string => pathToFileURL(path.join(DIST, nombre)).href;

/** Entorno de modo cerrado de I13 para toda invocación de la CLI en los tests. */
export const ENTORNO_CERRADO: Record<string, string> = {
  CI: "1",
  HYPERFRAMES_NO_UPDATE_CHECK: "1",
  HYPERFRAMES_NO_AUTO_INSTALL: "1",
  HYPERFRAMES_NO_OPTIONAL_INSTALL: "1",
  HYPERFRAMES_NO_TELEMETRY: "1",
  DO_NOT_TRACK: "1",
  HYPERFRAMES_SKIP_SKILLS: "1",
};

/**
 * Copia el entorno, borra en cualquier capitalización (Windows no distingue) las claves de `extra`,
 * los proxies propios (`NO_PROXY` abriría un hueco) y las `PUPPETEER_*`, y fija `extra`.
 * Un valor `undefined` en `extra` deja la clave borrada.
 */
export function entornoLimpio(base: NodeJS.ProcessEnv, extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const fuera = new Set([...Object.keys(extra), "NO_PROXY", "HYPERFRAMES_BROWSER_PATH", "PRODUCER_HEADLESS_SHELL_PATH"].map((k) => k.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    const K = k.toUpperCase();
    if (fuera.has(K) || K.startsWith("PUPPETEER_")) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

/** Primera IPv4 no interna del equipo; sin ella no se puede observar una fuga fuera de loopback. */
export function ipNoInterna(): string {
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const i of lista ?? []) if (i.family === "IPv4" && !i.internal) return i.address;
  }
  throw new Error("sin interfaz no loopback: no se puede observar una fuga");
}

export interface Sumidero {
  host: string;
  puerto: number;
  conexiones(): number;
  /** Primer trozo de cada conexión (la línea de la petición y las cabeceras, p. ej. el User-Agent). */
  peticiones(): string[];
  cerrar(): Promise<void>;
}

/** Servidor TCP que cuenta conexiones y guarda su primer trozo (no responde nada). */
export function sumidero(host = "127.0.0.1"): Promise<Sumidero> {
  let n = 0;
  const textos: string[] = [];
  const sockets = new Set<net.Socket>();
  const s = net.createServer((c) => {
    n++;
    sockets.add(c);
    c.on("error", () => {});
    c.on("close", () => sockets.delete(c));
    c.once("data", (d: Buffer) => textos.push(d.toString("latin1").slice(0, 500)));
    setTimeout(() => c.destroy(), 300);
  });
  return new Promise((ok, mal) => {
    s.once("error", mal);
    s.listen(0, host, () => {
      ok({
        host,
        puerto: (s.address() as net.AddressInfo).port,
        conexiones: () => n,
        peticiones: () => [...textos],
        cerrar: () =>
          new Promise<void>((r) => {
            for (const c of sockets) c.destroy();
            s.close(() => r());
          }),
      });
    });
  });
}

export interface SumideroUdp {
  host: string;
  puerto: number;
  paquetes(): number;
  cerrar(): Promise<void>;
}

/** Socket UDP que cuenta los datagramas que le llegan (STUN de WebRTC, QUIC). */
export function sumideroUdp(host = "127.0.0.1"): Promise<SumideroUdp> {
  let n = 0;
  const s = dgram.createSocket("udp4");
  s.on("message", () => n++);
  return new Promise((ok, mal) => {
    s.once("error", mal);
    s.bind(0, host, () => {
      ok({
        host,
        puerto: s.address().port,
        paquetes: () => n,
        cerrar: () => new Promise<void>((r) => s.close(() => r())),
      });
    });
  });
}

/** ¿Acepta `host:puerto` una conexión TCP? (2 s de tope). */
export function conecta(host: string, puerto: number): Promise<boolean> {
  return new Promise((ok) => {
    const c = net.connect({ host, port: puerto });
    const fin = (r: boolean) => {
      c.destroy();
      ok(r);
    };
    c.setTimeout(2000, () => fin(false));
    c.once("connect", () => fin(true));
    c.once("error", () => fin(false));
  });
}
