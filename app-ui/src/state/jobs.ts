/** Store de jobs (subida y transcripción). El SSE solo trae job_started y job_finished; el
 *  progreso se consulta con GET /jobs cada segundo mientras haya alguno queued/running.
 *  Vive fuera de React: cambiar de pantalla no corta el sondeo ni pierde el progreso. */
import { create } from "zustand";
import type { Client } from "../api/client";
import type { Job } from "../api/types";

export const jobActivo = (j: Job) => j.status === "queued" || j.status === "running";

export const useJobs = create<{ jobs: Record<string, Job> }>(() => ({ jobs: {} }));

let timer: ReturnType<typeof setTimeout> | null = null;

function programar(client: Client) {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    try {
      const lista = await client.listJobs();
      useJobs.setState((s) => {
        const jobs = { ...s.jobs };
        for (const j of lista) if (j.id in jobs) jobs[j.id] = j;
        return { jobs };
      });
    } catch {
      return; // sin sidecar no hay nada que sondear; el job_finished del stream cierra el bloque
    }
    if (Object.values(useJobs.getState().jobs).some(jobActivo)) programar(client);
  }, 1000);
}

/** Registra (o actualiza) un job y arranca el sondeo si sigue activo. */
export function seguirJob(client: Client, job: Job) {
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
  useJobs.setState({ jobs: {} });
}
