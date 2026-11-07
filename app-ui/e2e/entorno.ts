// Módulo puro (sin `process` ni APIs de Node): lo importan el global-setup de Playwright y
// los tests de vitest de `src/`, cuyo tsconfig no incluye los tipos de Node.

/** Entorno del sidecar de los E2E. Nunca hereda credenciales reales: toda variable `*_API_KEY` o
 *  `*_TOKEN`, `*_SECRET` o `*_PASSWORD` del entorno de Marc se sustituye por un valor falso, y ElevenLabs va al mock.
 *
 *  AVISO (hallazgo de seguridad de T14): mientras T5/T11 no hagan que el motor lea
 *  `VIDEO_PRUEBAS_TTS_URL`, el motor sigue apuntando a `api.elevenlabs.io`. Por eso la clave se
 *  neutraliza aquí: ningún E2E de voz debe poder llegar a la API real con una clave real. */
export function entornoSidecar(heredado: Readonly<Record<string, string | undefined>>, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(heredado)) {
    if (v === undefined) continue;
    env[k] = /(_?API_?KEY|_TOKEN|_SECRET|_PASSWORD)$/i.test(k) ? "e2e-falsa" : String(v);
  }
  env.ELEVENLABS_API_KEY = "e2e-eleven-falsa";
  env.ELEVENLABS_VOICE_ID = "voz-e2e";
  return { ...env, ...extra };
}
