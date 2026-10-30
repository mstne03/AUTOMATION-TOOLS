// node --import: anota en ESPIA_LOG y BLOQUEA todo intento de salir del equipo (nunca llega a la red), para
// que los controles sin parche prueben la fuga sin producirla. Bloquea rutas UNC en fs, TODO proceso hijo
// (ni ffprobe ni Chrome llegan a arrancar) y dns, sockets fuera de loopback y fetch. Con ESPIA_HIJOS=1 deja
// arrancar los hijos que no llevan una ruta de red: solo para el render real con el parche puesto.
import cp from "node:child_process";
import dns from "node:dns";
import EventEmitter from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";

const anotar = fs.appendFileSync.bind(fs);
const LOG = process.env.ESPIA_LOG;
const anota = (...a) => anotar(LOG, `${JSON.stringify(a)}\n`);
const texto = (p) => (p instanceof URL ? (p.host ? `//${p.host}${p.pathname}` : "") : Buffer.isBuffer(p) ? p.toString() : p);
const esUnc = (p) => {
  const t = texto(p);
  return typeof t === "string" && (/^[\\/]{2}/.test(t) || path.win32.resolve(t).startsWith("\\\\"));
};
const denegado = () => Object.assign(new Error("bloqueado por el espía"), { code: "ENOENT" });

for (const objeto of [fs, fs.promises]) {
  for (const n of Object.keys(objeto)) {
    const o = objeto[n];
    if (typeof o !== "function" || !/^[a-z]/.test(n)) continue;
    const envuelta = function (...r) {
      if (esUnc(r[0]) || (typeof r[1] === "string" && /^(copyFile|cp|link|rename|symlink)/.test(n) && esUnc(r[1]))) {
        anota(n, texto(r[0]));
        if (n === "existsSync") return false;
        if (objeto === fs.promises) return Promise.reject(denegado());
        const cb = r.at(-1);
        if (!n.endsWith("Sync") && typeof cb === "function") return void setImmediate(cb, denegado());
        throw denegado();
      }
      return Reflect.apply(o, this, r);
    };
    objeto[n] = Object.defineProperties(envuelta, Object.getOwnPropertyDescriptors(o));
  }
}

for (const n of ["realpath", "realpathSync"]) {
  const o = fs[n].native;
  fs[n].native = function (p, ...r) {
    if (esUnc(p)) {
      anota(`${n}.native`, texto(p));
      throw denegado();
    }
    return Reflect.apply(o, this, [p, ...r]);
  };
}

const proceso = () => {
  const e = new EventEmitter();
  e.stdout = new EventEmitter();
  e.stderr = new EventEmitter();
  e.stdin = { end() {}, on() {}, write() {} };
  e.kill = () => {};
  e.pid = 0;
  setImmediate(() => e.emit("close", 1, null));
  return e;
};
for (const n of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const o = cp[n];
  cp[n] = function (c, a) {
    const args = Array.isArray(a) ? a : [];
    const red = args.filter((x) => esUnc(x) || /^[a-z][a-z0-9+.-]+:[\\/]{2}/i.test(String(x)));
    if (esUnc(c) || red.length) anota(n, String(c).split(/[\\/]/).pop(), red);
    else if (process.env.ESPIA_HIJOS === "1") return Reflect.apply(o, this, arguments);
    if (n.endsWith("Sync")) {
      if (n === "spawnSync") return { status: 1, stdout: "", stderr: "", pid: 0, output: [] };
      throw denegado();
    }
    const cb = [...arguments].at(-1);
    if (n.startsWith("exec") && typeof cb === "function") setImmediate(cb, denegado(), "", "");
    return proceso();
  };
}

for (const objeto of [dns, dns.promises]) {
  for (const n of Object.keys(objeto)) {
    if (typeof objeto[n] !== "function" || !/^(lookup|resolve|reverse)/.test(n)) continue;
    const o = objeto[n];
    objeto[n] = function (h, ...r) {
      if (/^(localhost$|127\.)/.test(String(h)) && n === "lookup") return Reflect.apply(o, this, [h, ...r]);
      anota(`dns.${n}`, h);
      const cb = r.at(-1);
      if (typeof cb === "function") return void setImmediate(cb, denegado());
      return Promise.reject(denegado());
    };
  }
}
const conectar = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...r) {
  const o = Array.isArray(r[0]) ? r[0][0] : r[0];
  const destino = typeof o === "object" ? (o.path ?? o.host ?? "localhost") : (r[1] ?? "localhost");
  if (!/^(localhost$|127\.|::1$|\\\\\.\\pipe)/.test(String(destino))) {
    anota("net.connect", destino);
    setImmediate(() => this.destroy(denegado()));
    return this;
  }
  return Reflect.apply(conectar, this, r);
};
const traer = globalThis.fetch;
globalThis.fetch = async (u, ...r) => {
  const url = String(u?.url ?? u);
  if (/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)[:/]/i.test(url)) return traer(u, ...r);
  anota("fetch", url);
  throw denegado();
};
syncBuiltinESMExports();
