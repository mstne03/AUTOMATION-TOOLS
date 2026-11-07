// Módulo puro (sin `process` ni APIs de Node): lo importan el global-setup de Playwright y
// los tests de vitest de `src/`, cuyo tsconfig no incluye los tipos de Node.

/** Variables del sistema que el sidecar de los E2E puede heredar (lista blanca, como la invariante
 *  I5 de SPEC-video.md para los hijos del motor). Solo lo imprescindible para lanzar `uv run`, Python
 *  y node en Windows y Linux; nada de `*_PROXY`, `UV_INDEX*` ni credenciales. */
export const VARIABLES_HEREDADAS: readonly string[] = [
  "PATH", "Path", // localizar uv, node y python
  "PATHEXT", // Windows: resolver `uv` y `node` a `.exe`/`.cmd`
  "SystemRoot", "SYSTEMROOT", "WINDIR", // Windows: sin ellas fallan Winsock, el CSPRNG y los subprocesos
  "COMSPEC", // `shell: true` y `cmd.exe`
  "TEMP", "TMP", "TMPDIR", // directorio temporal de Python, uv y node
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", // `Path.home()` y la caché de uv
  "APPDATA", "LOCALAPPDATA", // Windows: uv y Python resuelven sus carpetas de usuario desde aquí
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", // Windows: módulos nativos y `platform`
  "LANG", "LC_ALL", // codificación de la consola
  "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR", // para no re-descargar el CPython ni las ruedas (uv corre con --no-sync)
];

/** Entorno del sidecar de los E2E. Lista blanca: solo se copian las variables de
 *  `VARIABLES_HEREDADAS`; cualquier otra (claves, tokens, proxies, índices privados) se descarta.
 *  Después se fuerza el aislamiento y se aplica `extra`.
 *
 *  Forzadas: el directorio de estado temporal (`extra.APP_BACKEND_DIR`), almacén `file` (nunca el
 *  Credential Manager), claves de Anthropic y ElevenLabs falsas, voz de prueba y sin `.env`.
 *
 *  Aviso: hasta que T5 (otra rama) haga que el motor lea `VIDEO_PRUEBAS_TTS_URL`, el motor sigue
 *  llamando a `api.elevenlabs.io` (con la clave falsa, que ese servicio rechaza). No se desactiva
 *  esa defensa ni se asume que el mock local atiende las llamadas de voz. */
export function entornoSidecar(heredado: Readonly<Record<string, string | undefined>>, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of VARIABLES_HEREDADAS) {
    const v = heredado[k];
    if (v !== undefined) env[k] = String(v);
  }
  return {
    ...env,
    ...extra,
    APP_BACKEND_SECRETS: "file",
    ANTHROPIC_API_KEY: "sk-ant-e2e-falsa",
    ELEVENLABS_API_KEY: "e2e-eleven-falsa",
    ELEVENLABS_VOICE_ID: "voz-e2e",
    APP_BACKEND_SIN_DOTENV: "1",
  };
}
