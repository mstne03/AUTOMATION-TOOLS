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

function programar(client: Client) {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    try {
      const lista = await client.listJobs();
      const actuales = useJobs.getState().jobs;
      const cambios: Record<string, Job> = {};
      for (const j of lista) {
        if (!(j.id in actuales)) continue;
        avisarFin(actuales[j.id], j); // fuera del updater de setState: este puede ejecutarse dos veces en StrictMode
        cambios[j.id] = j;
      }
      useJobs.setState((st) => ({ jobs: { ...st.jobs, ...cambios } }));
    } catch {
      return; // sin sidecar no hay nada que sondear; el job_finished del stream cierra el bloque
    }
    if (Object.values(useJobs.getState().jobs).some(jobActivo)) programar(client);
  }, 1000);
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
  useJobs.setState({ jobs: {} });
}
