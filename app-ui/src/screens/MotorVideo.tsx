/** Sección «Motor de vídeo» de Ajustes (docs/pantallas.md): descarga a petición del navegador del
 *  render (Chrome for Testing), su progreso y errores, y el modo de render. Sin selector de navegador
 *  ni ruta editable (I11). Todo va por el cliente HTTP del sidecar; los textos del backend se pintan
 *  como texto y sin rutas del sistema. */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCapacidadesVideo, useDescargarNavegador, useNavegadorVideo } from "../api/queries";
import { ApiError } from "../api/client";
import { FASES_ACTIVAS } from "../api/types";
import { hayGpuDe, modoEfectivo, setRenderModo, useRenderModo, type RenderModo } from "../state/renderModo";
import { sinRutas } from "../video/render/sinRutas";
import { ClaveElevenLabs } from "./MotorVideoClave";
import { Button, Chip, Progress, toast } from "../ui";
import { cx } from "../ui/cx";
import s from "./SettingsScreen.module.css";
import v from "./MotorVideo.module.css";

const MiB = 1024 * 1024;
const NO_INSTALADO = /no está instalado/i;
const ETIQUETA = { ausente: "No descargado", descargando: "Descargando…", verificando: "Verificando…", extrayendo: "Instalando…", listo: "Listo", error: "Error" } as const;

const MODOS: Array<[RenderModo, string, string]> = [
  ["auto", "Automático", "Dos pasadas; funciona en cualquier equipo"],
  ["rapido", "Rápido", "Una sola pasada con la GPU"],
  ["compatible", "Compatible", "Dos pasadas; funciona en cualquier equipo"],
];

export { sinRutas };
const esNoInstalado = (e: unknown) => e instanceof ApiError && e.status === 503 && NO_INSTALADO.test(e.detail);

export function MotorVideo() {
  const qc = useQueryClient();
  const nav = useNavegadorVideo();
  const descargar = useDescargarNavegador();
  const modo = useRenderModo((m) => m.modo);
  const d = nav.data;
  const estado = d?.estado;
  const listo = estado === "listo";
  const activa = !!estado && FASES_ACTIVAS.includes(estado);
  const cap = useCapacidadesVideo(listo);
  const { reset: olvidarError } = descargar;

  // Al retomar (409 → descargando → listo) el error del POST ya no es de este estado: que no reaparezca.
  useEffect(() => {
    if (activa || listo) olvidarError();
  }, [activa, listo, olvidarError]);

  // Al salir de «listo» (p. ej. «Volver a descargar») las capacidades guardadas ya no valen.
  useEffect(() => {
    if (estado && !listo) qc.removeQueries({ queryKey: ["video", "capacidades"] });
  }, [estado, listo, qc]);

  const sinMotor = esNoInstalado(descargar.error) || (listo && esNoInstalado(cap.error));
  // M9: «listo» no se hashea; si el motor no encuentra el navegador, hay salida: volver a descargarlo.
  const corrupto = listo && !sinMotor && (cap.isError || (!!cap.data && !cap.data.chrome && !!cap.data.gpu?.detalle));
  const textoError = sinRutas(
    (estado === "error" && d?.error) || (corrupto && (cap.error?.message ?? cap.data?.gpu?.detalle)) || (!activa && descargar.error?.message) || (nav.isError ? nav.error.message : "") || "",
  );
  const puedeDescargar = !sinMotor && (estado === "ausente" || estado === "error" || corrupto);
  const textoBoton = corrupto ? "Volver a descargar" : estado === "error" ? "Reintentar la descarga" : "Descargar el navegador del render";

  const mb = d ? Math.round(d.tamano / MiB) : 0;
  const progreso = estado === "descargando" && d && d.tamano > 0 ? d.descargado / d.tamano : undefined;
  const hayGpu = hayGpuDe(cap.data);
  const rapidoNo = !hayGpu;
  const avisoRapido = !listo
    ? "Descarga el navegador del render para comprobar los codificadores"
    : cap.isPending
      ? "Comprobando…"
      : cap.isError || corrupto
        ? "No se han podido comprobar los codificadores"
        : "No hay codificador de GPU: se usará Compatible";
  // «Rápido» guardado sin GPU no se marca (estaría deshabilitado y marcado): se enseña el modo efectivo.
  const efectivo: RenderModo = modoEfectivo(modo, hayGpu);

  const elegir = (m: RenderModo) => {
    if (m === modo) return;
    setRenderModo(m);
    toast({ title: "Modo de render guardado" });
  };

  return (
    <section id="ajustes-video" className={s.seccion} aria-labelledby="s-video" data-testid="ajustes-video">
      <div className={s.cabecera}>
        <div className={s.flex}>
          <h2 id="s-video" className={s.h2}>
            Motor de vídeo
          </h2>
          {d && (
            <p className={s.ayuda} data-testid="ajustes-video-aviso">
              El render usa Chrome for Testing {d.version} (~{mb} MB), que se descarga una sola vez de storage.googleapis.com, solo cuando tú lo pides, y se verifica antes de usarlo.
            </p>
          )}
        </div>
        {estado && (
          <span data-testid="ajustes-video-estado">
            <Chip tone={listo ? "success" : estado === "error" ? "destructive" : "read"}>{ETIQUETA[estado]}</Chip>
          </span>
        )}
      </div>

      {nav.isPending && <p className={s.ayuda}>Comprobando el navegador del render…</p>}

      {sinMotor && (
        <p className={s.aviso} data-testid="ajustes-video-sin-motor">
          El módulo de vídeo no está instalado en esta versión.
        </p>
      )}

      {activa && (
        <div data-testid="ajustes-video-progreso">
          <Progress
            label={estado === "descargando" ? "Descargando el navegador" : estado === "verificando" ? "Verificando la descarga" : "Instalando el navegador"}
            value={progreso}
            detail={progreso === undefined ? undefined : `${Math.round(d!.descargado / MiB)} de ${mb} MB`}
          />
        </div>
      )}

      {textoError && !sinMotor && (
        <p className={s.error} role="alert" data-testid="ajustes-video-error">
          {textoError}
        </p>
      )}

      {puedeDescargar && (
        <div className={s.acciones}>
          <Button variant="primary" data-testid="ajustes-video-descargar" loading={descargar.isPending} onClick={() => descargar.mutate()}>
            {textoBoton}
          </Button>
        </div>
      )}

      <div className={s.subseccion}>
        <h3 className={s.h3} id="s-render-modo">
          Modo de render
        </h3>
        <div role="radiogroup" aria-labelledby="s-render-modo" className={v.modos} data-testid="ajustes-render-modo">
          {MODOS.map(([id, nombre, desc]) => {
            const deshabilitado = id === "rapido" && rapidoNo;
            return (
              <button key={id} type="button" role="radio" aria-checked={efectivo === id} disabled={deshabilitado} className={cx(s.modelo, efectivo === id && s.modeloActivo, deshabilitado && v.deshabilitado)} data-testid={`ajustes-render-modo-${id}`} onClick={() => elegir(id)}>
                <span className={s.modeloNombre}>{nombre}</span>
                <span className={s.ayuda}>{desc}</span>
              </button>
            );
          })}
        </div>
        {rapidoNo && (
          <p className={s.ayuda} data-testid="ajustes-render-rapido-aviso">
            {avisoRapido}
          </p>
        )}
      </div>

      <ClaveElevenLabs />
    </section>
  );
}
