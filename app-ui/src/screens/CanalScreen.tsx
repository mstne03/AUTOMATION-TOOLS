/** Panel de canal (docs/pantallas.md → Canal): identidad, métricas de 28 días, últimos vídeos, cuota
 *  legible y preguntas sugeridas. Los datos salen de GET /youtube/channel (caché de 10 min). */
import { Film, Sparkles } from "lucide-react";
import { useNavigate } from "react-router";
import { useCanal, useYoutubeStatus } from "../api/queries";
import type { CanalPanel } from "../api/types";
import { formatearNumero, haceCuanto, horaLocal, reinicioCuota } from "../formato";
import { Button, Chip, EmptyState, Mono } from "../ui";
import { cx } from "../ui/cx";
import s from "./CanalScreen.module.css";
import { CuotaLista } from "./CuotaLista";

const SUGERENCIAS = ["¿Qué vídeo retuvo mejor y por qué?", "Propón 3 títulos para el próximo Short", "¿A qué hora publica mejor mi audiencia?"];
const ANALIZAR_CANAL = "Analiza mi canal: últimos vídeos, rendimiento y qué mejorar. Separa claramente datos de conclusiones.";

const ESTADO = {
  private: { texto: "Privado", tono: "read" },
  public: { texto: "Público", tono: "success" },
  unlisted: { texto: "Oculto", tono: "read" },
} as const;

const fechaCorta = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "short" }) : "");
const signo = (n: number) => (n > 0 ? "+" : "");

function Metrica({ titulo, valor, detalle, testid }: { titulo: string; valor: string; detalle: string; testid: string }) {
  return (
    <div className={s.metrica} data-testid={testid}>
      <span className={s.metricaTitulo}>{titulo}</span>
      <span className={s.metricaValor}>{valor}</span>
      <span className={s.metricaDetalle}>{detalle}</span>
    </div>
  );
}

function Metricas({ panel }: { panel: CanalPanel }) {
  const m = panel.metricas;
  const sinDatos = "Analytics no disponible";
  return (
    <section className={s.metricas} aria-label="Métricas">
      <Metrica
        testid="canal-metrica-suscriptores"
        titulo="Suscriptores"
        valor={formatearNumero(panel.canal.suscriptores)}
        detalle={m ? `${signo(m.suscriptores_netos)}${formatearNumero(m.suscriptores_netos)} en 28 días` : sinDatos}
      />
      <Metrica
        testid="canal-metrica-visualizaciones"
        titulo="Visualizaciones · 28 d"
        valor={m ? formatearNumero(m.visualizaciones) : "—"}
        detalle={m ? (m.visualizaciones_delta_pct === null ? "sin periodo previo" : `${signo(m.visualizaciones_delta_pct)}${m.visualizaciones_delta_pct.toLocaleString("es-ES")} % vs 28 d previos`) : sinDatos}
      />
      <Metrica testid="canal-metrica-horas" titulo="Horas vistas · 28 d" valor={m ? m.horas_vistas.toLocaleString("es-ES") : "—"} detalle={m ? "Analytics API, sin cuota" : sinDatos} />
      <Metrica testid="canal-metrica-retencion" titulo="Retención media" valor={m ? `${m.retencion_media.toLocaleString("es-ES")} %` : "—"} detalle={m ? "porcentaje medio visto" : sinDatos} />
    </section>
  );
}

export function CanalScreen() {
  const yt = useYoutubeStatus();
  const navegar = useNavigate();
  const autorizado = yt.data?.auth.authenticated ?? false;
  const perfil = yt.data?.auth.profile ?? "";
  const canal = useCanal(autorizado ? perfil : undefined);
  const preguntar = (mensaje: string) => navegar("/chat", { state: { mensaje } });
  const panel = canal.data;
  const nombre = panel ? panel.canal.handle ?? panel.canal.titulo : perfil;
  const reinicio = horaLocal(reinicioCuota());

  return (
    <div className={s.pantalla}>
      <header className={s.cabecera} data-testid="canal-estado">
        <div className={s.avatar} aria-hidden>
          {(nombre || "?").replace(/^@/, "").slice(0, 1).toUpperCase()}
        </div>
        <div className={s.identidad}>
          <h1 className={s.titulo}>{nombre || "Panel de canal"}</h1>
          <span className={s.subtitulo}>
            Perfil <Mono>{perfil}</Mono>
            {panel ? ` · datos de ${haceCuanto(panel.actualizado)}` : ""}
          </span>
        </div>
        {yt.data && <Chip tone={autorizado ? "success" : "write"}>{autorizado ? "Autorizado" : "Sin autorizar"}</Chip>}
        <Button data-testid="canal-cambiar" onClick={() => navegar("/ajustes")}>
          Cambiar de canal
        </Button>
        <Button variant="primary" icon={Sparkles} data-testid="canal-pregunta" disabled={!autorizado} onClick={() => preguntar(ANALIZAR_CANAL)}>
          Analizar con el agente
        </Button>
      </header>

      {yt.isError && <p className={s.error}>{yt.error.message}</p>}
      {yt.data && !autorizado && (
        <EmptyState
          title="El canal no está autorizado"
          description="Autoriza tu canal de YouTube para ver sus métricas y últimos vídeos."
          action={<Button onClick={() => navegar("/onboarding")}>Autorizar el canal</Button>}
        />
      )}
      {autorizado && canal.isPending && <p className={s.suave}>Cargando los datos del canal…</p>}
      {autorizado && canal.isError && (
        <p className={s.error} data-testid="canal-error" role="alert">
          {canal.error.message}
        </p>
      )}

      {panel && <Metricas panel={panel} />}

      <div className={s.cuerpo}>
        {panel && (
          <section className={s.videos} aria-labelledby="canal-ultimos">
            <div className={s.videosCabecera}>
              <h2 id="canal-ultimos" className={s.h2}>
                Últimos vídeos
              </h2>
              <Button size="sm" variant="ghost" onClick={() => void canal.refetch()} loading={canal.isFetching} data-testid="canal-actualizar">
                Actualizar
              </Button>
            </div>
            <div className={s.tablaCaja}>
              <table className={s.tabla} data-testid="canal-videos">
                <thead>
                  <tr>
                    <th scope="col">Vídeo</th>
                    <th scope="col">Estado</th>
                    <th scope="col" className={s.derecha}>
                      Vistas
                    </th>
                    <th scope="col" className={s.derecha}>
                      <span className={s.soloLectores}>Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {panel.videos.map((v) => {
                    const est = v.estado ? ESTADO[v.estado] : null;
                    const programado = v.programado_para !== null;
                    const publico = v.estado === "public";
                    return (
                      <tr key={v.id} data-testid={`canal-video-${v.id}`}>
                        <td>
                          <div className={s.videoCelda}>
                            <div className={s.miniatura} aria-hidden>
                              <Film size="1.2em" />
                            </div>
                            <div className={s.videoTexto}>
                              <span className={s.videoTitulo}>{v.titulo ?? "(sin título)"}</span>
                              <span className={s.videoMeta}>
                                {fechaCorta(v.publicado)} · {v.es_short ? "Short · " : ""}
                                <Mono>{v.id}</Mono>
                              </span>
                            </div>
                          </div>
                        </td>
                        <td>{est && <Chip tone={programado ? "info" : est.tono}>{programado ? "Programado" : est.texto}</Chip>}</td>
                        <td className={cx(s.derecha, s.vistas)}>{publico ? formatearNumero(v.visualizaciones) : "—"}</td>
                        <td className={s.derecha}>
                          <Button
                            size="sm"
                            data-testid={`canal-video-accion-${v.id}`}
                            onClick={() =>
                              preguntar(
                                publico
                                  ? `Analiza el vídeo ${v.id} («${v.titulo ?? ""}»): rendimiento, retención y qué mejorar. Separa datos de conclusiones.`
                                  : `Quiero editar los metadatos del vídeo ${v.id} («${v.titulo ?? ""}»). Léelo y propón cambios de título, descripción y etiquetas; no apliques nada sin mi aprobación.`,
                              )
                            }
                          >
                            {publico ? "Analizar" : "Editar"}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {panel.videos.length === 0 && <p className={s.vacio}>Este canal aún no tiene vídeos.</p>}
            </div>
          </section>
        )}

        <aside className={s.lateral}>
          {yt.data && (
            <section className={s.panel} aria-labelledby="canal-cuota-titulo" data-testid="canal-cuota">
              <div className={s.cuotaCabecera}>
                <h2 id="canal-cuota-titulo" className={s.h2}>
                  Cuota de hoy
                </h2>
                <span className={s.suave}>se reinicia a las {reinicio}</span>
              </div>
              <CuotaLista buckets={yt.data.quota.buckets} />
            </section>
          )}
          <section className={s.panel} aria-labelledby="canal-sugerencias">
            <h2 id="canal-sugerencias" className={s.h2}>
              Pregunta al agente
            </h2>
            {SUGERENCIAS.map((q, i) => (
              <button key={q} type="button" className={s.sugerencia} data-testid={`canal-sugerencia-${i + 1}`} disabled={!autorizado} onClick={() => preguntar(q)}>
                {q}
              </button>
            ))}
          </section>
        </aside>
      </div>
    </div>
  );
}
