/** Diálogo de render (docs/pantallas.md › Render): modo, bloqueos, progreso del job, resultado,
 *  avisos y exportar. El render lo hace el motor por `POST /video/proyectos/{id}/render`; el progreso
 *  sale del store de jobs (sigue vivo si se cierra el diálogo). La UI solo envía el id y el modo (I6):
 *  nunca rutas. Todo texto del servidor se pinta como texto y sin rutas del sistema (I1, I11). */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError } from "../../api/client";
import { useClient } from "../../api/context";
import { useCapacidadesVideo, useNavegadorVideo } from "../../api/queries";
import type { Job } from "../../api/types";
import { jobActivo, seguirJob, useJobs } from "../../state/jobs";
import { useEditor } from "../../state/editor";
import { hayGpuDe, modoEfectivo, useRenderModo } from "../../state/renderModo";
import { Button, Dialog, Progress } from "../../ui";
import { exportarMp4 } from "./exportar";
import s from "./Render.module.css";
import { aResultadoRender, segundos } from "./resultado";
import { sinRutas } from "./sinRutas";

/** Código con el que el backend rechaza renderizar un proyecto con frases sin voz (Task 11). */
const SIN_VOZ = "sin_voz";

const DESCRIPCION = {
  auto: "Modo Automático: dos pasadas; funciona en cualquier equipo.",
  rapido: "Modo Rápido: una sola pasada con la GPU.",
  compatible: "Modo Compatible: dos pasadas; funciona en cualquier equipo.",
} as const;

/** El job más reciente de render de este proyecto (el id del proyecto va en `args`, no es una ruta). */
const delProyecto = (jobs: Record<string, Job>, id: string): Job | undefined =>
  Object.values(jobs)
    .filter((j) => j.kind === "video_render" && j.args.id === id)
    .reduce<Job | undefined>((a, j) => (!a || j.created_at >= a.created_at ? j : a), undefined);

const mensaje = (e: unknown) => sinRutas(e instanceof Error ? e.message : String(e));

export function RenderDialogo({ id, onClose }: { id: string; onClose: () => void }) {
  const client = useClient();
  const qc = useQueryClient();
  const modo = useRenderModo((m) => m.modo);
  const guardado = useEditor((e) => e.guardado);
  const conflicto = useEditor((e) => e.conflicto);
  const job = useJobs((st) => delProyecto(st.jobs, id));
  const [lanzando, setLanzando] = useState(false);
  const [exportando, setExportando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sinVoz, setSinVoz] = useState<string | null>(null);

  // Capacidades: «Rápido» solo vale con un codificador de GPU (h264_mf, software, no cuenta).
  const nav = useNavegadorVideo();
  const navegadorListo = nav.data?.estado === "listo";
  const cap = useCapacidadesVideo(navegadorListo);
  const hayGpu = hayGpuDe(cap.data);
  const efectivo = modoEfectivo(modo, hayGpu);
  const esperandoCap = modo === "rapido" && navegadorListo && cap.isPending;

  // Retoma un render en curso (o el último) tras recargar: el store de jobs empieza vacío.
  useEffect(() => {
    let vivo = true;
    client
      .listJobs()
      .then((lista) => {
        if (!vivo) return;
        const ultimo = delProyecto(Object.fromEntries(lista.map((j) => [j.id, j])), id);
        if (ultimo && !(ultimo.id in useJobs.getState().jobs)) seguirJob(client, ultimo);
      })
      .catch(() => {
        /* sin lista: el diálogo funciona igual con lo que lance esta sesión */
      });
    return () => {
      vivo = false;
    };
  }, [client, id]);

  // La voz pendiente bloquea el render. No gasta: solo pregunta qué frases faltan.
  const voz = useQuery({ queryKey: ["video", "render-voz", id], queryFn: () => client.videoVozCoste(id), retry: false, gcTime: 0, staleTime: 0 });
  const pendientes = voz.data?.pendientes.length ?? 0;

  const estadoJob = job?.status;
  useEffect(() => {
    if (estadoJob === "done" || estadoJob === "failed") void qc.invalidateQueries({ queryKey: ["video", "proyectos"] });
  }, [estadoJob, qc]);

  const activo = !!job && jobActivo(job);
  const hecho = job?.status === "done";
  const fallido = job?.status === "failed";

  const bloqueo: { motivo: "guardado" | "voz"; texto: string } | null =
    guardado !== "guardado" || conflicto
      ? { motivo: "guardado", texto: conflicto ? "Resuelve el conflicto de guardado antes de renderizar." : "Espera a que termine de guardarse el proyecto." }
      : pendientes > 0
        ? { motivo: "voz", texto: `Faltan ${pendientes} ${pendientes === 1 ? "frase" : "frases"} por generar en la voz. Genera la voz en la línea de tiempo antes de renderizar.` }
        : sinVoz !== null
          ? { motivo: "voz", texto: sinVoz }
          : null;

  const lanzar = async () => {
    setError(null);
    setSinVoz(null);
    setLanzando(true);
    try {
      seguirJob(client, await client.videoRender(id, efectivo));
      void qc.invalidateQueries({ queryKey: ["video", "proyectos"] });
    } catch (e) {
      if (e instanceof ApiError && e.codigo === SIN_VOZ) setSinVoz(sinRutas(e.detail));
      else setError(mensaje(e));
    } finally {
      setLanzando(false);
    }
  };

  const exportar = async () => {
    setError(null);
    setExportando(true);
    try {
      await exportarMp4(id);
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setExportando(false);
    }
  };

  const r = hecho ? aResultadoRender(job.result) : null;
  const textoError = error ?? (fallido ? sinRutas(job.error ?? "El render ha fallado.") : null);
  const descripcion = DESCRIPCION[efectivo] + (modo === "rapido" && efectivo !== "rapido" && !esperandoCap ? " «Rápido» no está disponible en este equipo." : "");

  return (
    <Dialog
      open
      onOpenChange={(abierto) => !abierto && onClose()}
      title="Renderizar vídeo"
      description={descripcion}
      footer={
        <>
          <Button onClick={onClose}>Cerrar</Button>
          {!activo && (
            <Button variant="primary" data-testid="render-lanzar" loading={lanzando} disabled={lanzando || !!bloqueo || voz.isPending || esperandoCap} onClick={() => void lanzar()}>
              {hecho ? "Renderizar de nuevo" : fallido ? "Reintentar" : "Renderizar"}
            </Button>
          )}
        </>
      }>
      <div className={s.cuerpo} data-testid="render-dialogo">
        {bloqueo && !activo && (
          <p className={s.bloqueo} role="status" data-testid="render-bloqueo" data-motivo={bloqueo.motivo}>
            {bloqueo.texto}
          </p>
        )}

        {activo && (
          <div data-testid="render-progreso">
            <Progress label="Renderizando el vídeo" value={job.status === "queued" ? undefined : job.progress} />
          </div>
        )}

        {r && (
          <div className={s.resultado} data-testid="render-resultado">
            <p>{r.duracion === null ? "Vídeo listo." : `Vídeo listo · ${segundos(r.duracion)}`}</p>
            <ul className={s.avisos} data-testid="render-avisos">
              {r.codificador && <li>Codificador: {sinRutas(r.codificador)}{r.modo ? ` (modo ${sinRutas(r.modo)})` : ""}</li>}
              {r.reserva && <li className={s.reserva}>Reserva: {sinRutas(r.reserva)}</li>}
              {r.avisos.map((a, i) => (
                <li key={i}>{sinRutas(a)}</li>
              ))}
            </ul>
            <div className={s.acciones}>
              <Button variant="primary" data-testid="render-exportar" loading={exportando} disabled={exportando} onClick={() => void exportar()}>
                Exportar MP4
              </Button>
            </div>
          </div>
        )}

        {textoError && (
          <p className={s.error} role="alert" data-testid="render-error">
            {textoError}
          </p>
        )}
      </div>
    </Dialog>
  );
}
