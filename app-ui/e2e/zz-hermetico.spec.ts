/** SEO-131: los E2E no salen de loopback. Corre el último (nombre `zz-`; un solo worker, en orden):
 *  el sidecar en modo offline anota en `red-bloqueada.log` cada conexión que intentó fuera de loopback. */
import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("ninguna prueba E2E intentó salir de loopback", () => {
  const registro = join(process.env.E2E_STATE_DIR!, "red-bloqueada.log");
  const intentos = existsSync(registro) ? readFileSync(registro, "utf8").trim().split("\n") : [];
  expect(intentos, `El sidecar intentó conectar con: ${[...new Set(intentos)].join(", ")}`).toEqual([]);
});
