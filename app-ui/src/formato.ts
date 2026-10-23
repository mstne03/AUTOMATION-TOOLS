/** Formato de números, fechas y cuota para la UI (español). */

/** 10000 → "10.000", también 1000 → "1.000" (Intl con es-ES no agrupa los de cuatro cifras). */
export const formatearNumero = (n: number) => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/** Reinicio de la cuota de YouTube: medianoche del Pacífico, expresada en hora local. */
export function reinicioCuota(ahora: Date = new Date()): Date {
  const partes = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(ahora);
  const v = (t: string) => Number(partes.find((p) => p.type === t)?.value ?? 0);
  const transcurrido = ((v("hour") * 60 + v("minute")) * 60 + v("second")) * 1000;
  return new Date(ahora.getTime() + 24 * 3600 * 1000 - transcurrido);
}

export const horaLocal = (d: Date) => d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });

/** "hace unos segundos", "hace 2 min", "hace 3 h". */
export function haceCuanto(iso: string, ahora: Date = new Date()): string {
  const min = Math.floor((ahora.getTime() - new Date(iso).getTime()) / 60_000);
  if (Number.isNaN(min) || min < 1) return "hace unos segundos";
  if (min < 60) return `hace ${min} min`;
  return `hace ${Math.floor(min / 60)} h`;
}

/** Nombre legible de cada cubo de cuota de la API de YouTube. */
export const CUBOS: Record<string, { nombre: string }> = {
  general: { nombre: "Unidades" },
  search: { nombre: "Búsquedas" },
  video_insert: { nombre: "Subidas" },
};
