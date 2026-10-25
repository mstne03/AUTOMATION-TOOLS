/** Store de jobs (subida y transcripción). El SSE solo trae job_started y job_finished; el
 *  progreso se consulta con GET /jobs cada segundo mientras haya alguno queued/running.
 *  Vive fuera de React: cambiar de pantalla no corta el sondeo ni pierde el progreso. */
import { create } from "zustand";
import type { Client } from "../api/client";
import type { Job } from "../api/types";
import { toast } from "../ui/Toaster";

export const jobActivo = (j: Job) => j.status === "queued" || j.status === "running";

export const useJobs = create<{ jobs: Record<string, Job> }>(() => ({ jobs: {} }));

/** Resultado visible al terminar un job (UI-12): aviso con éxito o con el error. */
function avisarFin(antes: Job | undefined, ahora: Job) {
  if (!antes || !jobActivo(antes) || jobActivo(ahora)) return;
  const que = ahora.kind === "upload" ? "La subida" : "La transcripción";
  if (ahora.status === "failed") toast({ title: `${que} ha fallado`, description: ahora.error ?? undefined, tone: "error" });
  else toast({ title: `${que} ha terminado` });
}

let timer: ReturnType<typeof setTimeout> | null = null;
const INTERVALO_MS = 1000;
const ESPERA_MAXIMA_MS = 10_000;
/** Sondeos seguidos en los que un job activo no aparece en GET /jobs antes de darlo por perdido. */
const AUSENCIAS_MAXIMAS = 3;
const PERDIDO = "El sidecar ya no conoce este trabajo (se reinició o se cerró la app). Vuelve a lanzarlo.";
let fallosSeguidos = 0;
const ausencias = new Map<string, number>();

/** Sondea mientras haya jobs activos. Un fallo de red no lo corta (SEO-91): reintenta con espera
 *  creciente (1, 2, 4, 8 y 10 s); un job activo que desaparece de la lista se da por fallido. */
function programar(client: Client) {
  if (timer) return;
  const espera = Math.min(INTERVALO_MS * 2 ** fallosSeguidos, ESPERA_MAXIMA_MS);
  timer = setTimeout(async () => {
    timer = null;
    try {
      const lista = await client.listJobs();
      fallosSeguidos = 0;
      const actuales = useJobs.getState().jobs;
      const enLista = new Set(lista.map((j) => j.id));
      const cambios: Record<string, Job> = {};
      for (const j of lista) {
        if (!(j.id in actuales)) continue;
        ausencias.delete(j.id);
        avisarFin(actuales[j.id], j); // fuera del updater de setState: este puede ejecutarse dos veces en StrictMode
        cambios[j.id] = j;
      }
      for (const j of Object.values(actuales)) {
        if (!jobActivo(j) || enLista.has(j.id)) continue;
        const veces = (ausencias.get(j.id) ?? 0) + 1;
        ausencias.set(j.id, veces);
        if (veces < AUSENCIAS_MAXIMAS) continue;
        ausencias.delete(j.id);
        const perdido: Job = { ...j, status: "failed", error: PERDIDO };
        avisarFin(j, perdido);
        cambios[j.id] = perdido;
      }
      useJobs.setState((st) => ({ jobs: { ...st.jobs, ...cambios } }));
    } catch {
      fallosSeguidos += 1; // sidecar caído o reiniciándose: se reintenta más tarde
    }
    if (Object.values(useJobs.getState().jobs).some(jobActivo)) programar(client);
    else fallosSeguidos = 0;
  }, espera);
}

/** Registra (o actualiza) un job y arranca el sondeo si sigue activo. */
export function seguirJob(client: Client, job: Job) {
  avisarFin(useJobs.getState().jobs[job.id], job);
  useJobs.setState((s) => ({ jobs: { ...s.jobs, [job.id]: job } }));
  if (jobActivo(job)) programar(client);
}

/** Resuelve cuando el job deja de estar queued/running (done o failed). */
export function esperarJob(id: string): Promise<Job> {
  return new Promise((resolve) => {
    let desuscribir: () => void = () => {};
    const revisar = (s: { jobs: Record<string, Job> }) => {
      const j = s.jobs[id];
      if (j && !jobActivo(j)) {
        desuscribir();
        resolve(j);
      }
    };
    desuscribir = useJobs.subscribe(revisar);
    revisar(useJobs.getState());
  });
}

/** Solo para tests. */
export function reiniciarJobs() {
  if (timer) clearTimeout(timer);
  timer = null;
  fallosSeguidos = 0;
  ausencias.clear();
  useJobs.setState({ jobs: {} });
}
