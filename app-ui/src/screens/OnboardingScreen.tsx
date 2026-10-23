/** Onboarding (docs/pantallas.md → Onboarding): clave, asistente de Google Cloud con
 *  validador por paso, OAuth y estado de la KB. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useClient } from "../api/context";
import { usePutSettings, useSettings, useYoutubeStatus } from "../api/queries";

const CONSOLE = "https://console.cloud.google.com/apis/library/youtube.googleapis.com";
const CREDENCIALES = "https://console.cloud.google.com/apis/credentials";
// En estado "Prueba" Google emite refresh tokens que caducan a los 7 días: hay que publicar la app.
const PUBLICO = "https://console.cloud.google.com/auth/audience";

/** Validador del client_secret.json de una app "de escritorio". Devuelve el motivo del fallo. */
export function validarClientSecret(texto: string): string | null {
  let j: unknown;
  try {
    j = JSON.parse(texto);
  } catch {
    return "No es JSON válido.";
  }
  const inst = (j as { installed?: Record<string, unknown> })?.installed;
  if (!inst) return 'Falta la clave "installed": las credenciales deben ser de tipo "Aplicación de escritorio".';
  if (typeof inst.client_id !== "string" || !inst.client_id) return 'Falta "installed.client_id".';
  if (typeof inst.client_secret !== "string" || !inst.client_secret) return 'Falta "installed.client_secret".';
  return null;
}

export function OnboardingScreen() {
  const client = useClient();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const settings = useSettings();
  const yt = useYoutubeStatus();
  const put = usePutSettings();
  const kb = useQuery({ queryKey: ["kb", "estado"], queryFn: () => client.kbEstado(), retry: 1 });

  const [apiKey, setApiKey] = useState("");
  const [paso2a, setPaso2a] = useState(false);
  const [paso2b, setPaso2b] = useState(false);
  const [paso2c, setPaso2c] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [path, setPath] = useState("");
  const [googleError, setGoogleError] = useState<string | null>(null);

  const importar = useMutation({
    mutationFn: (body: { json_text?: string; path?: string }) => client.importClientSecret(body),
    onSuccess: (data) => {
      qc.setQueryData(["settings"], data);
      setJsonText("");
      setPath("");
      setGoogleError(null);
    },
    onError: (e) => setGoogleError(e.message),
  });
  const oauth = useMutation({
    mutationFn: () => client.youtubeAuth({}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["youtube", "status"] }),
  });

  if (settings.isPending) return <p className="estado">Cargando…</p>;
  if (settings.isError) return <p className="estado error">Error: {settings.error.message}</p>;
  const s = settings.data;

  const hechoClave = s.has_anthropic_key;
  const hechoGoogle = s.has_client_secret;
  const hechoOauth = !!yt.data?.auth.authenticated;
  const hechoKb = kb.isSuccess;

  const onImportar = () => {
    if (jsonText.trim()) {
      const err = validarClientSecret(jsonText);
      if (err) return setGoogleError(err);
      return importar.mutate({ json_text: jsonText });
    }
    if (path.trim()) return importar.mutate({ path: path.trim() });
    setGoogleError("Pega el JSON o indica la ruta del fichero.");
  };

  return (
    <div className="onboarding">
      <h1>Primeros pasos</h1>
      <ol className="pasos" data-testid="onboarding-pasos">
        <Paso id="paso-clave" titulo="Clave de Anthropic" hecho={hechoClave}>
          <p className="nota">
            El agente usa tu propia clave (BYOK). Se guarda en el Credential Manager de Windows y no se vuelve a mostrar.
          </p>
          <div className="fila">
            <input type="password" data-testid="clave-input" placeholder="sk-ant-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
            <button
              data-testid="clave-guardar"
              disabled={!apiKey || put.isPending}
              onClick={() => {
                put.mutate({ anthropic_api_key: apiKey });
                setApiKey("");
              }}
            >
              Guardar
            </button>
          </div>
          {put.error && <p className="error">{put.error.message}</p>}
        </Paso>

        <Paso id="paso-google" titulo="Proyecto de Google Cloud" hecho={hechoGoogle}>
          <p className="nota">
            YouTube exige que cada usuario traiga su propio proyecto de Google Cloud (gratuito). Cuatro sub-pasos:
          </p>
          <ol className="subpasos">
            <li>
              <label>
                <input type="checkbox" data-testid="google-paso-a" checked={paso2a} onChange={(e) => setPaso2a(e.target.checked)} />{" "}
                Crea un proyecto y activa <strong>YouTube Data API v3</strong>:{" "}
                <a href={CONSOLE} target="_blank" rel="noopener noreferrer">
                  abrir la biblioteca de APIs
                </a>
                .
              </label>
            </li>
            <li>
              <label>
                <input type="checkbox" data-testid="google-paso-b" checked={paso2b} onChange={(e) => setPaso2b(e.target.checked)} />{" "}
                En{" "}
                <a href={CREDENCIALES} target="_blank" rel="noopener noreferrer">
                  Credenciales
                </a>
                , crea un <strong>ID de cliente OAuth</strong> de tipo <strong>Aplicación de escritorio</strong> y descarga el JSON.
              </label>
            </li>
            <li>
              <label>
                <input type="checkbox" data-testid="google-paso-c" checked={paso2c} onChange={(e) => setPaso2c(e.target.checked)} />{" "}
                En{" "}
                <a href={PUBLICO} target="_blank" rel="noopener noreferrer">
                  Público
                </a>
                , pulsa <strong>Publicar aplicación</strong>. Si la dejas en «Prueba», Google desconecta tu canal cada 7 días y
                tendrías que volver a autorizarlo.
              </label>
            </li>
            <li>
              Importa el JSON descargado (se guarda cifrado; el fichero original puedes borrarlo):
              <textarea data-testid="google-json" rows={4} placeholder='{"installed": {"client_id": …}}' value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
              <div className="fila">
                <span>o ruta:</span>
                <input data-testid="google-path" placeholder="C:\Users\…\client_secret_….json" value={path} onChange={(e) => setPath(e.target.value)} />
                <button data-testid="google-importar" disabled={importar.isPending || !(paso2a && paso2b && paso2c)} onClick={onImportar}>
                  Importar
                </button>
              </div>
              {googleError && (
                <p className="error" data-testid="google-error">
                  {googleError}
                </p>
              )}
            </li>
          </ol>
        </Paso>

        <Paso id="paso-oauth" titulo="Autorizar tu canal de YouTube" hecho={hechoOauth}>
          <p className="nota">Se abre el navegador con el consentimiento de Google. Es la única acción que abre el navegador.</p>
          <p className="nota" data-testid="oauth-no-verificada">
            Google avisará de que «no ha verificado esta app»: es tu propio proyecto y es normal. Pulsa «Configuración avanzada» y
            luego «Ir a …» para continuar.
          </p>
          <button data-testid="oauth-autorizar" disabled={!hechoGoogle || oauth.isPending} onClick={() => oauth.mutate()}>
            {oauth.isPending ? "Se ha abierto el navegador…" : "Autorizar canal de YouTube"}
          </button>
          {oauth.error && <p className="error">{oauth.error.message}</p>}
        </Paso>

        <Paso id="paso-kb" titulo="Base de conocimiento" hecho={hechoKb}>
          {kb.isPending && <p>Comprobando…</p>}
          {kb.isError && <p className="error">{kb.error.message}</p>}
          {kb.data && <pre data-testid="kb-estado-texto">{kb.data.texto}</pre>}
        </Paso>
      </ol>
      <button data-testid="onboarding-terminar" disabled={!(hechoClave && hechoGoogle && hechoOauth)} onClick={() => navigate("/chat")}>
        Ir al chat
      </button>
    </div>
  );
}

function Paso({ id, titulo, hecho, children }: { id: string; titulo: string; hecho: boolean; children: ReactNode }) {
  return (
    <li data-testid={id} data-estado={hecho ? "hecho" : "pendiente"} className={`paso ${hecho ? "hecho" : ""}`}>
      <h2>
        {hecho ? "✓" : "○"} {titulo}
      </h2>
      {children}
    </li>
  );
}
