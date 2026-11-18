/** SEO-131: el sidecar no sale de loopback durante los E2E. Corre el último (nombre `zz-`; un solo worker, en
 *  orden): el sidecar en modo offline anota en `red-bloqueada.log` cada conexión que intentó fuera de loopback.
 *  Límite: solo vigila el proceso Python del sidecar (parchea su `socket`). No cubre la UI que carga Playwright,
 *  ni el motor de vídeo en Node ni el Chrome que este lanza: esos procesos no pasan por ese `socket`. */
import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("el sidecar no intentó salir de loopback en ningún E2E", () => {
  const registro = join(process.env.E2E_STATE_DIR!, "red-bloqueada.log");
  const intentos = existsSync(registro) ? readFileSync(registro, "utf8").trim().split("\n") : [];
  expect(intentos, `El sidecar intentó conectar con: ${[...new Set(intentos)].join(", ")}`).toEqual([]);
});
