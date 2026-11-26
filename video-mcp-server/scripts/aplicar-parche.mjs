// Aplica el parche local de HyperFrames y comprueba el SHA-256 de cada fichero (SEO-109).
//   node scripts/aplicar-parche.mjs [carpeta]
// `carpeta` es la que contiene node_modules/hyperframes (por defecto, video-mcp-server). Es idempotente y
// falla con código 1 si el resultado no coincide con el fijado: no hay paquete a medio parchear.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVIDOR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PARCHE = path.join(SERVIDOR, "patches", "hyperframes+0.8.206.patch");
const HASHES = path.join(SERVIDOR, "patches", "hyperframes+0.8.206.sha256.json");

const raiz = path.resolve(process.argv[2] ?? SERVIDOR);

/** git absoluto de un PATH fuera de `raiz`: en Windows, libuv mira antes el cwd y ahí podría haber otro. */
function gitFuera() {
  const nombre = process.platform === "win32" ? "git.exe" : "git";
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    const rel = path.relative(raiz, d);
    const dentro = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (path.isAbsolute(d) && !dentro && fs.existsSync(path.join(d, nombre))) return path.join(d, nombre);
  }
  throw new Error(`git no se resuelve fuera de ${raiz}`);
}

// Dentro de un repo, git apply interpreta las rutas desde su raíz y se SALTA en silencio las que caen
// fuera del cwd: el techo impide que suba. autocrlf=false evita que convierta el dist a CRLF en Windows.
const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(raiz) };

try {
  const binario = gitFuera();
  const git = (args, stdio) => execFileSync(binario, ["-c", "core.autocrlf=false", "apply", ...args, PARCHE], { cwd: raiz, env, stdio });
  try {
    git(["--reverse", "--check"], "ignore"); // ya aplicado
  } catch {
    git(["--verbose"], "inherit");
  }
  const { ficheros, sinParche } = JSON.parse(fs.readFileSync(HASHES, "utf8"));
  if (!Object.keys(ficheros ?? {}).length || !Object.keys(sinParche ?? {}).length) throw new Error("el JSON de hashes no lista ficheros");
  for (const [fichero, esperado] of Object.entries({ ...ficheros, ...sinParche })) {
    const hash = createHash("sha256").update(fs.readFileSync(path.join(raiz, "node_modules", "hyperframes", fichero))).digest("hex");
    if (hash !== esperado) throw new Error(`${fichero}: SHA-256 inesperado (${hash})`);
  }
} catch (e) {
  console.error(`Parche de HyperFrames sin aplicar en ${raiz}: ${e.message}`);
  process.exit(1);
}
