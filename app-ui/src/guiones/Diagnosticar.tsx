/** Guiones → Diagnosticar: la retención se pide al sidecar directamente (sin el agente) y el agente
 *  solo interpreta los momentos ya calculados (SPEC-guiones.md, D2). */
import { Activity, BookmarkPlus, RotateCcw, Sparkles } from "lucide-react";
import { useNavigate } from "react-router";
import { useClient } from "../api/context";
import { useCanal, useSettings, useYoutubeStatus } from "../api/queries";
import { useChat } from "../chat/useChat";
import { analizarRetencion, CONVERSACION, empezarDeNuevo, parcharDiagnosticar, useGuiones } from "../state/guiones";
import { Button, Chip, EmptyState, Field, Input, Mono } from "../ui";
import { cx } from "../ui/cx";
import { Ayuda, SelectorFormato, Turnos } from "./comunes";
import { Curva } from "./Curva";
import s from "./Guiones.module.css";
import { extraerVideoId, mmss, pp, promptGuardar, promptProponer, type Momento } from "./modelo";

export function Diagnosticar() {
  const client = useClient();
  const navegar = useNavigate();
  const perfil = useSettings().data?.profile;
  const yt = useYoutubeStatus();
  const autorizado = yt.data?.auth.authenticated === true;
  const canal = useCanal(autorizado ? yt.data?.auth.profile : undefined);
  const chat = useChat(CONVERSACION.diagnosticar);
  const d = useGuiones((st) => st.diagnosticar);
  const r = d.resultado;

  const videoId = extraerVideoId(d.entrada);
  const idInvalido = d.entrada.trim() !== "" && !videoId;
  const motivo = !yt.data ? null : !autorizado ? "Autoriza tu canal en Ajustes u Onboarding." : null;
  const propuestaHecha = d.propuesto && chat.mensajes.some((m) => m.role === "assistant" && m.turno.estado === "done");

  const proponer = () => {
    if (!r) return;
    parcharDiagnosticar({ propuesto: true });
    void chat.enviar(promptProponer(r), { perfil });
  };

  if (yt.data && !autorizado) {
    return (
      <div className={s.cuerpo}>
        <div className={s.principal}>
          <EmptyState
            icon={Activity}
            title="El canal no está autorizado"
            description="Para ver dónde se va la audiencia hace falta leer YouTube Analytics de tu canal."
            action={<Button onClick={() => navegar("/onboarding")}>Autorizar el canal</Button>}
          />
          <p className={s.motivo} data-testid="diag-motivo">
            {motivo}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={s.cuerpo}>
      <div className={s.principal}>
        <form
          className={s.tarjeta}
          aria-label="Vídeo a diagnosticar"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (videoId && autorizado && !d.cargando && !chat.enStream) void analizarRetencion(client, videoId);
          }}
        >
          <div className={s.fila}>
            <Field label="Vídeo" className={s.crece} errorTestId="diag-video-error" error={idInvalido ? "No es un ID ni una URL de vídeo de YouTube." : undefined}>
              <Input mono data-testid="diag-video" placeholder="ID o URL del vídeo" value={d.entrada} onChange={(ev) => parcharDiagnosticar({ entrada: ev.target.value })} />
            </Field>
            <SelectorFormato testid="diag-formato" valor={d.formato} onChange={(formato) => parcharDiagnosticar({ formato })} />
          </div>
          <div className={s.acciones}>
            <Button type="submit" variant="primary" icon={Activity} data-testid="diag-analizar" disabled={!autorizado || !videoId || d.cargando || chat.enStream} loading={d.cargando}>
              {d.cargando ? "Analizando…" : "Analizar retención"}
            </Button>
            <p className={s.nota} data-testid="diag-nota">
              Cuesta unas 100 unidades de cuota (transcripción oficial). Los datos de retención tardan 1–2 días en aparecer tras publicar.
            </p>
          </div>
        </form>

        {d.error && (
          <p className={s.aviso} data-testid="diag-error" role="alert">
            {d.error}
          </p>
        )}

        {r && (
          <section className={s.tarjeta} data-testid="diag-resultado" aria-labelledby="diag-titulo">
            <div className={s.tarjetaCabecera}>
              <h2 id="diag-titulo" className={s.h2} data-testid="diag-titulo">
                {r.title ?? r.video_id} · {mmss(r.duration_s)}
              </h2>
              <Button size="sm" variant="ghost" icon={RotateCcw} disabled={chat.enStream} onClick={() => empezarDeNuevo("diagnosticar")}>
                Empezar de nuevo
              </Button>
            </div>
            {r.intro_retention !== null && (
              <p className={s.metricaIntro} data-testid="diag-intro" data-nivel={r.intro_retention < 0.5 ? "aviso" : "ok"}>
                <span className={s.metricaValor}>{Math.round(r.intro_retention * 100)} %</span> <span>sigue viendo a los {r.intro_window_s} s</span>
                {r.intro_retention < 0.5 && (
                  <>
                    {" "}
                    <Chip tone="write">Gancho débil</Chip>
                  </>
                )}
              </p>
            )}
            <Curva r={r} />
            {r.transcript_error && (
              <p className={s.nota} data-testid="diag-sin-transcripcion">
                Sin transcripción: {r.transcript_error}. Los momentos se muestran sin texto.
              </p>
            )}
            <h3 className={s.h3}>Dónde se va la gente</h3>
            <TablaMomentos testid="diag-caidas" fila="caida" columna="Pérdida" momentos={r.drops} vacio="No hay caídas destacables." />
            {r.spikes.length > 0 && (
              <>
                <h3 className={s.h3}>Qué se vuelve a ver</h3>
                <TablaMomentos testid="diag-picos" fila="pico" columna="Ganancia" momentos={r.spikes} />
              </>
            )}
            <div className={s.acciones}>
              <Button variant="primary" icon={Sparkles} data-testid="diag-proponer" disabled={chat.enStream} onClick={proponer}>
                Proponer mejoras
              </Button>
              <Button icon={BookmarkPlus} data-testid="diag-guardar" disabled={chat.enStream || !propuestaHecha} onClick={() => void chat.enviar(promptGuardar(r), { perfil })}>
                Guardar aprendizaje
              </Button>
            </div>
          </section>
        )}

        <Turnos chat={chat} testid="diag-turnos" />
      </div>

      <aside className={s.lateral} aria-label="Vídeos del canal">
        {canal.data && canal.data.videos.length > 0 && (
          <section className={s.panel} data-testid="diag-videos" aria-labelledby="diag-videos-titulo">
            <span id="diag-videos-titulo" className={s.panelTitulo}>
              Tus últimos vídeos
            </span>
            <ul className={s.videos}>
              {canal.data.videos.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    className={cx(s.video, videoId === v.id && s.videoElegido)}
                    data-testid={`diag-video-${v.id}`}
                    aria-pressed={videoId === v.id}
                    onClick={() => parcharDiagnosticar({ entrada: v.id, formato: v.es_short ? "short" : "long" })}
                  >
                    <span className={s.videoTitulo}>{v.titulo ?? "(sin título)"}</span>
                    <span className={s.videoMeta}>
                      {v.es_short ? "Short · " : ""}
                      <Mono>{v.id}</Mono>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <Ayuda titulo="Cómo se lee">
          <p>La curva es el porcentaje de la audiencia que sigue viendo en cada momento. La línea discontinua marca el final de la ventana del gancho.</p>
          <p>Cada caída lleva la frase que sonaba: es lo que el agente propone reescribir.</p>
        </Ayuda>
      </aside>
    </div>
  );
}

function TablaMomentos({ testid, fila, columna, momentos, vacio }: { testid: string; fila: string; columna: string; momentos: Momento[]; vacio?: string }) {
  return (
    <div className={s.tablaCaja}>
      <table className={s.tabla} data-testid={testid}>
        <colgroup>
          <col className={s.colMomento} />
          <col className={s.colDelta} />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Momento</th>
            <th scope="col">{columna}</th>
            <th scope="col">Qué se decía</th>
          </tr>
        </thead>
        <tbody>
          {momentos.length === 0 ? (
            <tr>
              <td colSpan={3}>{vacio}</td>
            </tr>
          ) : (
            momentos.map((m, i) => (
              <tr key={i} data-testid={fila}>
                <td className={s.num}>
                  {mmss(m.t_start)}–{mmss(m.t_end)}
                </td>
                <td className={cx(s.num, m.delta < 0 ? s.perdida : s.ganancia)}>{pp(m.delta)}</td>
                <td>{m.quote ?? "—"}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
