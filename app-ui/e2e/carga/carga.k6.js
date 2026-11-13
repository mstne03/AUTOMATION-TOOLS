// Target: k6 v2.4.0. Prueba de carga de /video/* (PR #27). Lo lanza orquestador.mjs (BASE, TOKEN y DATOS
// por entorno; todo en 127.0.0.1). Perfil: una app de escritorio con UN usuario, no un servidor público.
import http from "k6/http";
import exec from "k6/execution";
import { check, sleep } from "k6";
import { Counter, Rate } from "k6/metrics";

const BASE = __ENV.BASE;
const TOKEN = __ENV.TOKEN;
const D = JSON.parse(__ENV.DATOS);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE)) throw new Error("BASE debe ser http://127.0.0.1:<puerto>");

const c5xx = new Counter("respuestas_5xx");
const inesperadas = new Rate("estado_inesperado");
const sinRespuesta = new Counter("sin_respuesta");
const corrupcion = new Counter("proyecto_corrupto");
const conflictos409 = new Counter("conflictos_409");
const guardados = new Counter("guardados_ok");

// Un escenario por flujo; arrancan escalonados para aislar cuellos de botella y luego se solapan (guardar+preview).
export const options = {
  scenarios: {
    // Aislado y primero: sondea ffmpeg y GPU y, como el motor es un solo proceso, bloquea al resto mientras dura.
    capacidades: { executor: "constant-arrival-rate", rate: 1, timeUnit: "10s", duration: "40s", preAllocatedVUs: 2, maxVUs: 4, exec: "capacidades" },
    listados: { executor: "constant-arrival-rate", rate: 5, timeUnit: "1s", duration: "30s", preAllocatedVUs: 5, maxVUs: 20, startTime: "45s", exec: "listados" },
    // Coste: un usuario lo pide al editar el texto, no a ráfagas; 0,5/s ya es generoso.
    coste: { executor: "constant-arrival-rate", rate: 1, timeUnit: "2s", duration: "20s", preAllocatedVUs: 3, maxVUs: 8, startTime: "77s", exec: "coste" },
    voz: { executor: "per-vu-iterations", vus: 3, iterations: 1, maxDuration: "60s", startTime: "103s", exec: "voz" },
    recursos: { executor: "shared-iterations", vus: 3, iterations: 12, maxDuration: "60s", startTime: "133s", exec: "recursos" },
    preview_mientras_guarda: { executor: "constant-vus", vus: 4, duration: "30s", startTime: "175s", exec: "previewMientrasGuarda" },
    pico: {
      executor: "ramping-arrival-rate", startRate: 5, timeUnit: "1s", preAllocatedVUs: 20, maxVUs: 80, startTime: "211s", exec: "pico",
      stages: [{ target: 5, duration: "5s" }, { target: 80, duration: "5s" }, { target: 80, duration: "15s" }, { target: 5, duration: "5s" }],
    },
    // La ráfaga de guardados va al final porque, tras ella, la importación de recursos deja de responder (ver informe).
    guardar_concurrente: { executor: "constant-vus", vus: 4, duration: "30s", startTime: "247s", exec: "guardarConcurrente" },
    recursos_tras_guardar: { executor: "shared-iterations", vus: 1, iterations: 2, maxDuration: "75s", startTime: "280s", exec: "recursosTrasGuardar" },
  },
  thresholds: {
    respuestas_5xx: ["count==0"],
    sin_respuesta: ["count==0"],
    proyecto_corrupto: ["count==0"],
    estado_inesperado: ["rate==0"],
    // p95 por endpoint (valores de piloto local; el informe los discute contra lo medido).
    "http_req_duration{name:GET /video/proyectos}": ["p(95)<300"],
    "http_req_duration{name:GET /video/guiones}": ["p(95)<300"],
    // Sondea ffmpeg y GPU: se pide una vez al abrir la pantalla, no es una ruta caliente.
    "http_req_duration{name:GET /video/capacidades}": ["p(95)<5000"],
    "http_req_duration{name:GET /video/proyectos/{id}}": ["p(95)<300"],
    "http_req_duration{name:PUT /video/proyectos/{id}}": ["p(95)<800"],
    "http_req_duration{name:POST /video/proyectos/{id}/recursos}": ["p(95)<10000"], // 3 VUs serializados por el cerrojo del proyecto
    "http_req_duration{name:POST /video/proyectos/{id}/recursos (tras guardar)}": ["p(95)<10000"],
    "http_req_duration{name:POST /video/proyectos/{id}/voz/coste}": ["p(95)<3000"],
    "http_req_duration{name:POST /video/proyectos/{id}/voz}": ["p(95)<5000"],
    "http_req_duration{name:POST /video/proyectos/{id}/preview}": ["p(95)<1500"],
    "http_req_duration{name:GET preview/index.html}": ["p(95)<300"],
    // Sin criterio de aceptación: solo hacen que k6 exporte la latencia de cada escenario por separado.
    ...Object.fromEntries(["capacidades", "listados", "coste", "voz", "recursos", "preview_mientras_guarda", "pico", "guardar_concurrente", "recursos_tras_guardar"].map((n) => [`http_req_duration{scenario:${n}}`, ["max>=0"]])),
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

// Diagnóstico: SOLO=a,b ejecuta solo esos escenarios (conservando la separación entre ellos);
// RECURSOS_VUS cambia la concurrencia de `recursos`.
if (__ENV.SOLO) {
  const nombres = __ENV.SOLO.split(",");
  const t = (n) => Number((options.scenarios[n].startTime || "0s").replace("s", ""));
  const base = Math.min(...nombres.map(t));
  const elegidos = {};
  for (const n of nombres) {
    const e = options.scenarios[n];
    e.startTime = `${t(n) - base}s`;
    if (n === "recursos" && __ENV.RECURSOS_VUS) e.vus = Number(__ENV.RECURSOS_VUS);
    elegidos[n] = e;
  }
  options.scenarios = elegidos;
}

const CAB = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function llamar(metodo, ruta, nombre, cuerpo, esperados, cabeceras) {
  const r = http.request(metodo, ruta.startsWith("http") ? ruta : BASE + ruta, cuerpo === undefined ? null : JSON.stringify(cuerpo), {
    headers: cabeceras ?? CAB,
    tags: { name: nombre },
    responseCallback: http.expectedStatuses(...esperados),
  });
  if (r.status === 0) sinRespuesta.add(1); // timeout de k6 (60 s) o conexión rota
  else if (r.status >= 500) c5xx.add(1);
  inesperadas.add(!esperados.includes(r.status));
  return r;
}
const json = (r) => { try { return r.json(); } catch (e) { return null; } };

export function capacidades() {
  llamar("GET", "/video/capacidades", "GET /video/capacidades", undefined, [200]);
}

export function listados() {
  if (exec.scenario.iterationInTest % 2) llamar("GET", "/video/guiones", "GET /video/guiones", undefined, [200]);
  else llamar("GET", "/video/proyectos", "GET /video/proyectos", undefined, [200]);
}

// Abrir (GET) y guardar (PUT) el mismo proyecto desde 4 VUs. Las iteraciones impares envían una revisión
// vieja a propósito: se espera 409, nunca un 5xx ni un proyecto ilegible. Tras cada 409 se relee y se valida.
export function guardarConcurrente() {
  const id = D.guardar;
  const g = llamar("GET", `/video/proyectos/${id}`, "GET /video/proyectos/{id}", undefined, [200]);
  const p = json(g);
  if (!p || p.id !== id || !Number.isInteger(p.revision)) { corrupcion.add(1); return; }
  const vieja = exec.scenario.iterationInTest % 2 === 1 && p.revision > 0;
  const rev = vieja ? p.revision - 1 : p.revision;
  p.revision = rev;
  p.titulo = `Carga ${exec.vu.idInTest}-${exec.scenario.iterationInTest}`.slice(0, 60);
  const r = llamar("PUT", `/video/proyectos/${id}`, "PUT /video/proyectos/{id}", { revision: rev, proyecto: p }, [200, 409]);
  if (r.status === 200) { guardados.add(1); const j = json(r); if (!j || !Number.isInteger(j.revision) || j.revision <= rev) corrupcion.add(1); }
  if (r.status === 409) {
    conflictos409.add(1);
    const v = json(llamar("GET", `/video/proyectos/${id}`, "GET /video/proyectos/{id}", undefined, [200]));
    if (!v || v.id !== id) corrupcion.add(1);
  }
  sleep(0.05);
}

// 12 archivos ya colocados en la bandeja (los consume una sola vez), importados desde 3 VUs a la vez.
export function recursos() {
  const i = exec.scenario.iterationInTest;
  llamar("POST", `/video/proyectos/${D.recursos}/recursos`, "POST /video/proyectos/{id}/recursos",
    { bandeja_id: D.bandeja[i], clase: "foto", nombre_original: `carga-${i}.png` }, [201]);
}

// Sonda del fallo: mismas llamadas que `recursos`, pero justo después de la ráfaga de guardados.
export function recursosTrasGuardar() {
  const i = exec.scenario.iterationInTest;
  llamar("POST", `/video/proyectos/${D.recursos}/recursos`, "POST /video/proyectos/{id}/recursos (tras guardar)",
    { bandeja_id: D.bandeja[12 + i], clase: "foto", nombre_original: `tras-${i}.png` }, [201]);
}

export function coste() {
  const r = llamar("POST", `/video/proyectos/${D.voz}/voz/coste`, "POST /video/proyectos/{id}/voz/coste", {}, [200]);
  check(r, { "coste con plan": (x) => typeof (json(x) || {}).plan === "string" });
}

// 3 VUs piden coste y confirman la voz a la vez: gana una, las otras reciben 409 «ocupado» o ya no hay pendientes.
export function voz() {
  const c = json(llamar("POST", `/video/proyectos/${D.voz}/voz/coste`, "POST /video/proyectos/{id}/voz/coste", {}, [200]));
  if (!c) return;
  llamar("POST", `/video/proyectos/${D.voz}/voz`, "POST /video/proyectos/{id}/voz", { plan_confirmado: c.plan, caracteres_confirmados: c.caracteres }, [200, 409, 422]);
}

// El editor abre la preview, pide su index.html y el proyecto sigue guardándose.
export function previewMientrasGuarda() {
  const id = D.preview;
  if (exec.vu.idInTest % 2 === 0) {
    const r = llamar("POST", `/video/proyectos/${id}/preview`, "POST /video/proyectos/{id}/preview", {}, [200]);
    const j = json(r);
    if (j && j.url) {
      if (!/^http:\/\/127\.0\.0\.1:4781[0-3]\//.test(j.url)) throw new Error("URL de preview fuera de loopback: " + j.url);
      const p = llamar("GET", j.url, "GET preview/index.html", undefined, [200], {});
      check(p, { "preview HTML": (x) => String(x.body).includes("<") });
    }
  } else {
    const p = json(llamar("GET", `/video/proyectos/${id}`, "GET /video/proyectos/{id}", undefined, [200]));
    if (!p || p.id !== id) { corrupcion.add(1); return; }
    llamar("PUT", `/video/proyectos/${id}`, "PUT /video/proyectos/{id}", { revision: p.revision, proyecto: p }, [200, 409]);
  }
  sleep(0.05);
}

// Pico corto: ráfaga de lecturas (lo que hace la UI al abrir la lista y un proyecto).
export function pico() {
  if (exec.scenario.iterationInTest % 2) llamar("GET", "/video/proyectos", "GET /video/proyectos", undefined, [200]);
  else llamar("GET", `/video/proyectos/${D.listado[exec.scenario.iterationInTest % D.listado.length]}`, "GET /video/proyectos/{id}", undefined, [200]);
}
