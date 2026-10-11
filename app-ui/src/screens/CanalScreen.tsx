/** Panel de canal (docs/pantallas.md → Canal): estado + cuota; el análisis lo hace el chat. */
import { useNavigate } from "react-router";
import { useYoutubeStatus } from "../api/queries";
import { Cuota } from "./SettingsScreen";

export function CanalScreen() {
  const yt = useYoutubeStatus();
  const navigate = useNavigate();
  return (
    <div className="canal">
      <h1>Panel de canal</h1>
      {yt.isPending && <p>Cargando…</p>}
      {yt.isError && <p className="error">{yt.error.message}</p>}
      {yt.data && (
        <section data-testid="canal-estado">
          <p>
            Perfil <code>{yt.data.auth.profile}</code> ·{" "}
            {yt.data.auth.authenticated ? "Autorizado" : "Sin autorizar (ve a Ajustes u Onboarding)"}
          </p>
          <Cuota buckets={yt.data.quota.buckets} />
        </section>
      )}
      <p className="nota">
        El análisis completo del canal cuesta unas 4 unidades de cuota. Los datos de YouTube aparecen en el chat
        como "Datos"; el texto del modelo es su interpretación.
      </p>
      <button
        data-testid="canal-pregunta"
        disabled={!yt.data?.auth.authenticated}
        onClick={() =>
          navigate("/chat", {
            state: { mensaje: "Analiza mi canal: últimos vídeos, rendimiento y qué mejorar. Separa claramente datos de conclusiones." },
          })
        }
      >
        Analizar mi canal en el chat
      </button>
    </div>
  );
}
