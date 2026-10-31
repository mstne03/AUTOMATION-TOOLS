// W2.6 (SEO-114): constantes compartidas por los tests del parche del glue de shaders.
import path from "node:path";
import { SERVER_ROOT } from "../src/raiz.js";

export const VENDOR = path.join(SERVER_ROOT, "plantilla", "vendor", "shaders.iife.js");
export const PARCHE_SHADERS = path.join(SERVER_ROOT, "plantilla", "vendor", "shaders.iife.patch");

/** Glue del upstream (`renderSyntheticFrame` encadenado en una cola serie). Literal de spikes/shader/variantes.mjs. */
export const OE_ORIGINAL =
  "Ji=YE(),T0=Promise.resolve();function OE(e){return T0=T0.then(()=>Ji.renderSyntheticFrame(e-Ji.__testing.getFrameDiagnostics().globalElapsedTime)),T0}";

/** Glue «el último gana»: literal de `shadersParcheW26` (spikes/INFORME-shader.md §6). No se «mejora» sin repetir las medidas. */
export const OE_NUEVO =
  "Ji=YE(),T0=null,hfPendiente=0,hfHay=!1;function OE(e){if(!Number.isFinite(e))return T0||Promise.resolve();hfPendiente=e;hfHay=!0;" +
  "return T0||(T0=(async()=>{await null;try{for(;hfHay;){hfHay=!1;let t=hfPendiente;" +
  "await Ji.renderSyntheticFrame(t-Ji.__testing.getFrameDiagnostics().globalElapsedTime)}}finally{T0=null;hfHay&&OE(hfPendiente).catch(()=>{})}})())}";

/** SHA-256 del vendor upstream: el que fija catalogo/hyperframes.lock.json. */
export const HASH_BASE = "6ad60b5fe00c6f092ddc9ccc6138743d89401e2886d550b275fc8ce0d0345f2d";

/** SHA-256 del vendor con el glue parcheado (se fija en la Task 3). */
export const HASH_PARCHEADO = "PENDIENTE";
