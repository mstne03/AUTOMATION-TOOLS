import path from "node:path";
import { fileURLToPath } from "node:url";

// Carpeta del propio servidor (sirve igual desde src/ con tsx que desde dist/).
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
