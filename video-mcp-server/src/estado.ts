// Carpeta de estado del motor: logs y cachés. En el producto el motor vive en la carpeta de instalación
// (solo lectura), así que el anfitrión indica por VIDEO_STATE_DIR dónde se puede escribir.
import path from "node:path";
import { SERVER_ROOT } from "./raiz.js";

export const STATE_DIR: string = process.env.VIDEO_STATE_DIR?.trim()
  ? path.resolve(process.env.VIDEO_STATE_DIR.trim())
  : path.join(SERVER_ROOT, "logs");
