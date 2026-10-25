/** Onboarding (docs/pantallas.md → Onboarding): asistente de bienvenida a ancho completo, sin barra
 *  lateral, con un paso visible cada vez: clave de Anthropic, proyecto de Google Cloud, autorizar el
 *  canal y base de conocimiento. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Play } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useClient } from "../api/context";
import { useSettings, useYoutubeStatus } from "../api/queries";
import { EnlaceExterno } from "../enlaces";
import { Button, Estado, Field, Input, Progress, toast } from "../ui";
import { cx } from "../ui/cx";
import s from "./OnboardingScreen.module.css";
import { avisarCanalAutorizado, CONSOLE, CREDENCIALES, ImportarClientSecret, nombreCanal, PUBLICO } from "./ProyectoGoogle";

const PASOS = [
  { id: "paso-clave", titulo: "Clave de Anthropic" },
  { id: "paso-google", titulo: "Google Cloud" },
  { id: "paso-oauth", titulo: "Autorizar canal" },
  { id: "paso-kb", titulo: "Base de conocimiento" },
] as const;

export function OnboardingScreen() {
  const client = useClient();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const settings = useSettings();
  const yt = useYoutubeStatus();
  const kb = useQuery({ queryKey: ["kb", "estado"], queryFn: () => client.kbEstado(), retry: 1 });

  const [apiKey, setApiKey] = useState("");
  const [claveError, setClaveError] = useState<string | null>(null);
  const [paso2a, setPaso2a] = useState(false);
  const [paso2b, setPaso2b] = useState(false);
  const [paso2c, setPaso2c] = useState(false);
  const [elegido, setElegido] = useState<number | null>(null);

  const guardarClave = useMutation({
    mutationFn: async (clave: string) => {
      // Antes de marcar el paso como hecho: una llamada barata a Anthropic (GET /v1/models, sin coste).
      const r = await client.validateAnthropicKey(clave);
      if (!r.valida) throw new Error(r.detalle ?? "La clave no es válida.");
      return client.putSettings({ anthropic_api_key: clave });
    },
    onSuccess: (datos) => {
      qc.setQueryData(["settings"], datos);
      setApiKey("");
      setClaveError(null);
      setElegido(null); // al completar un paso, el asistente sigue al siguiente pendiente
      toast({ title: "Clave validada y guardada" });
    },
    onError: (e) => setClaveError(e.message),
  });
  /** `reautorizar`: ignora el token guardado y vuelve a pedir el consentimiento de Google. */
  const oauth = useMutation({
    mutationFn: (reautorizar: boolean) => client.youtubeAuth(reautorizar ? { reauthorize: true } : {}),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["youtube"] });
      setElegido(null);
      avisarCanalAutorizado(r);
    },
  });

  if (settings.isPending) return <Estado>Cargando…</Estado>;
  if (settings.isError) return <Estado error>Error: {settings.error.message}</Estado>;
  const st = settings.data;

  const hechos = [st.has_anthropic_key, st.has_client_secret, !!yt.data?.auth.authenticated, kb.isSuccess];
  const primerPendiente = hechos.slice(0, 3).findIndex((h) => !h);
  // Mientras el usuario no navegue, el asistente va al primer paso pendiente; con todo hecho, al final
  // ("Todo listo"), nunca a un paso ya hecho. Completar un paso vuelve a esta regla (setElegido(null)).
  const actual = elegido ?? (primerPendiente === -1 ? PASOS.length - 1 : primerPendiente);
  const alcanzable = (i: number) => i <= (primerPendiente === -1 ? 3 : primerPendiente);
  const listo = hechos[0] && hechos[1] && hechos[2];
  const hechosEnTotal = hechos.filter(Boolean).length;

  return (
    <div className={s.pantalla} data-testid="onboarding">
      <header className={s.cabecera}>
        <div className={s.marca}>
          <div className={s.logo}>
            <Play aria-hidden size="0.9em" />
          </div>
          <span className={s.marcaNombre}>SEO Studio</span>
        </div>
        <div className={s.progreso}>
          <div className={s.progresoTexto}>
            <h1 className={s.titulo}>Primeros pasos</h1>
            <span className={s.suave} data-testid="onboarding-progreso">
              Paso {actual + 1} de {PASOS.length}
            </span>
          </div>
          <Progress label="Progreso de la configuración" value={hechosEnTotal / PASOS.length} />
          <ol className={s.migas} aria-label="Pasos">
            {PASOS.map((p, i) => (
              <li key={p.id} aria-current={i === actual ? "step" : undefined}>
                <button type="button" className={cx(s.miga, i === actual && s.migaActual, hechos[i] && s.migaHecha)} disabled={!alcanzable(i)} data-testid={`onboarding-ir-${p.id}`} onClick={() => setElegido(i)}>
                  <span className={s.migaNumero}>{hechos[i] ? <Check aria-hidden size="0.9em" /> : i + 1}</span>
                  {p.titulo}
                </button>
              </li>
            ))}
          </ol>
        </div>
      </header>

      <main className={s.cuerpo}>
        <ol className={s.pasos} data-testid="onboarding-pasos">
          <Paso id="paso-clave" titulo="Clave de Anthropic" hecho={hechos[0]} visible={actual === 0}>
            <p className={s.ayuda}>El agente usa tu propia clave (BYOK). Se comprueba con Anthropic, se guarda en el almacén de credenciales de Windows y no se vuelve a mostrar.</p>
            <form
              className={s.fila}
              onSubmit={(e) => {
                e.preventDefault();
                if (apiKey) guardarClave.mutate(apiKey.trim());
              }}
            >
              <Field label={hechos[0] ? "Nueva clave (ya hay una guardada)" : "Clave de la API"} className={s.crece} error={claveError ?? undefined} errorTestId="clave-error">
                <Input type="password" mono data-testid="clave-input" placeholder="sk-ant-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
              </Field>
              <Button type="submit" variant="primary" data-testid="clave-guardar" disabled={!apiKey} loading={guardarClave.isPending}>
                {guardarClave.isPending ? "Comprobando…" : "Validar y guardar"}
              </Button>
            </form>
          </Paso>

          <Paso id="paso-google" titulo="Proyecto de Google Cloud" hecho={hechos[1]} visible={actual === 1}>
            <p className={s.ayuda}>YouTube exige que cada usuario traiga su propio proyecto de Google Cloud (gratuito). Esta lista es una guía: no bloquea nada.</p>
            <ul className={s.checklist}>
              <li>
                <label>
                  <input type="checkbox" data-testid="google-paso-a" checked={paso2a} onChange={(e) => setPaso2a(e.target.checked)} />
                  <span>Crea un proyecto y activa <strong>YouTube Data API v3</strong>: <EnlaceExterno href={CONSOLE}>abrir la biblioteca de APIs</EnlaceExterno>.</span>
                </label>
              </li>
              <li>
                <label>
                  <input type="checkbox" data-testid="google-paso-b" checked={paso2b} onChange={(e) => setPaso2b(e.target.checked)} />
                  <span>En <EnlaceExterno href={CREDENCIALES}>Credenciales</EnlaceExterno>, crea un <strong>ID de cliente OAuth</strong> de tipo <strong>Aplicación de escritorio</strong> y descarga el JSON.</span>
                </label>
              </li>
              <li>
                <label>
                  <input type="checkbox" data-testid="google-paso-c" checked={paso2c} onChange={(e) => setPaso2c(e.target.checked)} />
                  <span>En <EnlaceExterno href={PUBLICO}>Público</EnlaceExterno>, pulsa <strong>Publicar aplicación</strong>. Si la dejas en «Prueba», Google desconecta tu canal cada 7 días y tendrías que volver a autorizarlo.</span>
                </label>
              </li>
            </ul>

            {st.google_project && (
              <p className={s.ok} data-testid="google-proyecto">
                <Check aria-hidden size="1em" /> Proyecto <Mono>{st.google_project.project_id ?? "sin nombre"}</Mono> · cliente <Mono>{st.google_project.client_id}</Mono>
              </p>
            )}
            <p className={s.ayuda}>Es un solo proyecto para toda la app: todos tus canales lo usan y comparten su cuota diaria.</p>
            <ImportarClientSecret onImportado={() => setElegido(null)} />
          </Paso>

          <Paso id="paso-oauth" titulo="Autorizar tu canal de YouTube" hecho={hechos[2]} visible={actual === 2}>
            <p className={s.ayuda}>Se abre el navegador con el consentimiento de Google. Es la única acción que abre el navegador.</p>
            <p className={s.aviso} data-testid="oauth-no-verificada">
              Google avisará de que «no ha verificado esta app»: es tu propio proyecto y es normal. Pulsa «Configuración avanzada» y luego «Ir a …» para continuar.
            </p>
            {hechos[2] && (
              <p className={s.ok} data-testid="oauth-estado">
                <Check aria-hidden size="1em" /> Canal autorizado · {nombreCanal(yt.data?.auth.channel) ?? <>perfil <Mono>{yt.data?.auth.profile}</Mono></>}
              </p>
            )}
            {!hechos[2] && typeof yt.data?.auth.reason === "string" && (
              <p className={s.aviso} data-testid="oauth-motivo" role="alert">
                {yt.data.auth.reason}
              </p>
            )}
            <div className={s.fila}>
              {/* Ya autorizado: "Volver a autorizar" pide de nuevo el consentimiento (p. ej. para cambiar de cuenta). */}
              <Button variant={hechos[2] ? "secondary" : "primary"} data-testid="oauth-autorizar" disabled={!hechos[1]} loading={oauth.isPending} onClick={() => oauth.mutate(hechos[2])}>
                {oauth.isPending ? "Se ha abierto el navegador…" : hechos[2] ? "Volver a autorizar" : "Autorizar canal de YouTube"}
              </Button>
              {/* Si se cierra la pestaña de Google, el sidecar esperaría hasta su límite: esto lo corta. */}
              {oauth.isPending && (
                <Button data-testid="oauth-cancelar" onClick={() => void client.youtubeAuthCancel().catch(() => undefined)}>
                  Cancelar
                </Button>
              )}
            </div>
            {oauth.isPending && (
              <p className={s.ayuda} data-testid="oauth-ayuda-google">
                Elige en el navegador la cuenta de Google del canal. Si Google bloquea el acceso, esa cuenta no es usuario de prueba del proyecto: añádela o publica la app en <EnlaceExterno href={PUBLICO}>Público</EnlaceExterno>.
              </p>
            )}
            {!hechos[1] && <p className={s.ayuda}>Primero importa las credenciales de Google.</p>}
            {oauth.error && (
              <div className={s.fila}>
                <p className={s.error} data-testid="oauth-error">
                  {oauth.error.message}
                </p>
                <Button size="sm" variant="ghost" data-testid="oauth-ir-google" onClick={() => setElegido(1)}>
                  Revisar el proyecto de Google
                </Button>
              </div>
            )}
          </Paso>

          <Paso id="paso-kb" titulo="Base de conocimiento" hecho={hechos[3]} visible={actual === 3}>
            {listo && (
              <p className={s.ok} data-testid="onboarding-listo" role="status">
                <Check aria-hidden size="1em" /> Todo listo: clave, proyecto de Google y canal configurados. Ya puedes ir al chat.
              </p>
            )}
            <p className={s.ayuda}>El agente consulta una base de conocimiento de SEO en redes (se actualiza sola). Este es su estado:</p>
            {kb.isPending && <p className={s.suave}>Comprobando…</p>}
            {kb.isError && <p className={s.error}>{kb.error.message}</p>}
            {kb.data && (
              <pre className={s.estadoKb} data-testid="kb-estado-texto">
                {kb.data.texto}
              </pre>
            )}
          </Paso>
        </ol>

        <div className={s.navegacion}>
          <Button variant="ghost" data-testid="onboarding-atras" disabled={actual === 0} onClick={() => setElegido(actual - 1)}>
            Atrás
          </Button>
          {actual < PASOS.length - 1 && (
            <Button variant="primary" data-testid="onboarding-continuar" disabled={!hechos[actual]} onClick={() => setElegido(actual + 1)}>
              Continuar
            </Button>
          )}
          {/* Siempre hay salida: un paso que no se puede completar ahora (p. ej. Google rechaza la
              autorización) no puede dejar al usuario encerrado; el aviso de la barra recuerda lo que falta. */}
          <Button variant={listo && actual === PASOS.length - 1 ? "primary" : "secondary"} data-testid="onboarding-terminar" onClick={() => navigate("/chat", listo ? { state: { bienvenida: true } } : undefined)}>
            {listo ? "Ir al chat" : "Terminar más tarde"}
          </Button>
        </div>
      </main>
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className={s.mono}>{children}</code>;
}

function Paso({ id, titulo, hecho, visible, children }: { id: string; titulo: string; hecho: boolean; visible: boolean; children: ReactNode }) {
  return (
    <li data-testid={id} data-estado={hecho ? "hecho" : "pendiente"} hidden={!visible} className={s.paso}>
      <h2 className={s.h2}>
        <span className={cx(s.estado, hecho && s.estadoHecho)} aria-hidden>
          {hecho ? <Check size="0.9em" /> : "○"}
        </span>
        {titulo}
        <span className={s.soloLectores}>{hecho ? " (hecho)" : " (pendiente)"}</span>
      </h2>
      {children}
    </li>
  );
}
