/** JSON en respuestas del modelo: el primer objeto `{…}` del texto, validado con un guard. */
export function extraerJson<T>(texto: string, valido: (j: unknown) => j is T): T | null {
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j: unknown = JSON.parse(m[0]);
    return valido(j) ? j : null;
  } catch {
    return null;
  }
}

export const esObjeto = (j: unknown): j is Record<string, unknown> =>
  typeof j === "object" && j !== null && !Array.isArray(j);
