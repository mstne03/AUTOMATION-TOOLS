/** Barra lateral: logo, paleta, navegación, conversaciones, job activo, aviso de configuración y
 *  pie con el canal activo. Los testids nav / nav-* se conservan (docs/pantallas.md). */
import { BookOpen, ChartLine, MessageSquare, Play, Plus, Search, Trash2, TriangleAlert, Upload, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router";
import { useClient } from "../api/context";
import { useSettings, useYoutubeStatus } from "../api/queries";
import { abrirPaleta } from "../CommandPalette";
import { alCambiarDePerfil, borrar, cargarLista, delPerfil, nueva, seleccionar, useConversaciones } from "../state/conversations";
import { jobActivo, useJobs } from "../state/jobs";
import { ConfirmDialog, IconButton, Kbd, Progress, toast } from "../ui";
import { cx } from "../ui/cx";
import s from "./Sidebar.module.css";

const enlaces: Array<[string, string, LucideIcon]> = [
  ["chat", "Chat", MessageSquare],
  ["publicar", "Publicar", Upload],
  ["canal", "Canal", ChartLine],
  ["kb", "Conocimiento", BookOpen],
];

const nombreFichero = (job: { args: Record<string, unknown> }) => {
  const f = String(job.args.file ?? job.args.file_path ?? "");
  return f.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "";
};

function JobActivo() {
  const job = useJobs((st) => Object.values(st.jobs).find(jobActivo));
  if (!job) return null;
  const verbo = job.kind === "upload" ? "Subiendo" : "Transcribiendo";
  return (
    <div className={s.job} data-testid="nav-job" role="status">
      <Progress label={`${verbo} ${nombreFichero(job)}`.trim()} value={job.status === "queued" ? undefined : job.progress} />
    </div>
  );
}

/** Chats del perfil (canal) activo, guardados en el sidecar: se cargan al arrancar y se borran con
 *  confirmación. Al cambiar de perfil, el chat abierto pasa a uno de ese perfil. */
function Conversaciones({ perfil }: { perfil?: string }) {
  const client = useClient();
  const navegar = useNavigate();
  const estado = useConversaciones();
  const { conversaciones, activa } = estado;
  const [borrando, setBorrando] = useState<string | null>(null);

  useEffect(() => {
    cargarLista(client).catch((e: Error) => toast({ title: "No se pudieron cargar las conversaciones", description: e.message, tone: "error" }));
  }, [client]);
  useEffect(() => {
    if (perfil) alCambiarDePerfil(perfil);
  }, [perfil]);

  const titulo = (id: string) => conversaciones[id]?.titulo || "Nueva conversación";
  return (
    <section className={s.conversaciones} aria-label="Conversaciones" data-testid="nav-conversaciones">
      <div className={s.cabecera}>
        <span className={s.etiqueta}>Conversaciones</span>
        <IconButton
          icon={Plus}
          size="xs"
          variant="ghost"
          aria-label="Nueva conversación"
          data-testid="conv-nueva"
          onClick={() => {
            nueva(perfil);
            navegar("/chat");
          }}
        />
      </div>
      <ul className={s.lista}>
        {delPerfil(estado, perfil).map((id) => (
          <li key={id} className={s.fila}>
            <button
              type="button"
              className={cx(s.conv, id === activa && s.convActiva)}
              aria-current={id === activa ? "true" : undefined}
              data-testid={`conv-${id}`}
              onClick={() => {
                seleccionar(id);
                navegar("/chat");
              }}
            >
              {titulo(id)}
            </button>
            <IconButton
              icon={Trash2}
              size="xs"
              variant="ghost"
              className={s.borrar}
              aria-label={`Borrar la conversación «${titulo(id)}»`}
              data-testid={`conv-borrar-${id}`}
              disabled={conversaciones[id]?.enStream}
              onClick={() => setBorrando(id)}
            />
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={borrando !== null}
        onOpenChange={(a) => !a && setBorrando(null)}
        title="¿Borrar la conversación?"
        description={borrando ? `«${titulo(borrando)}» se borrará de este equipo y no se podrá recuperar.` : undefined}
        confirmLabel="Borrar"
        tone="danger"
        onConfirm={async () => {
          if (!borrando) return;
          try {
            await borrar(client, borrando);
            toast({ title: "Conversación borrada" });
          } catch (e) {
            toast({ title: "No se pudo borrar la conversación", description: (e as Error).message, tone: "error" });
          }
        }}
      />
    </section>
  );
}

export function Sidebar() {
  const settings = useSettings();
  const youtube = useYoutubeStatus();
  const perfil = youtube.data?.auth.profile ?? settings.data?.profile ?? "default";
  const autorizado = youtube.data?.auth.authenticated ?? false;
  // El título del canal (de YouTube, texto plano) si el sidecar lo sabe; si no, el nombre del perfil.
  const nombre = youtube.data?.auth.channel?.title ?? perfil;
  // Falta algún paso del asistente de bienvenida (clave, proyecto de Google Cloud o canal autorizado).
  const faltaConfigurar = settings.data ? !settings.data.has_anthropic_key || !settings.data.has_client_secret || (youtube.data ? !autorizado : false) : false;

  return (
    <nav className={s.barra} data-testid="nav" aria-label="Principal">
      <div className={s.marca}>
        <div className={s.logo}>
          <Play aria-hidden size="0.9em" />
        </div>
        <h2 className={s.titulo}>SEO Studio</h2>
      </div>

      <button type="button" className={s.buscar} onClick={abrirPaleta} data-testid="nav-paleta">
        <Search aria-hidden size="1.15em" />
        <span className={s.buscarTexto}>Buscar o ejecutar…</span>
        <Kbd>Ctrl K</Kbd>
      </button>

      <div className={s.enlaces}>
        {enlaces.map(([ruta, nombre, Icono]) => (
          <NavLink key={ruta} to={`/${ruta}`} data-testid={`nav-${ruta}`} className={({ isActive }) => cx(s.enlace, isActive && s.activo)}>
            <Icono aria-hidden size="1.15em" />
            {nombre}
          </NavLink>
        ))}
      </div>

      <Conversaciones perfil={settings.data?.profile} />

      <div className={s.pie}>
        {faltaConfigurar && (
          <NavLink to="/onboarding" data-testid="nav-onboarding" className={s.aviso}>
            <TriangleAlert aria-hidden size="1.15em" />
            <span>Completa la configuración</span>
          </NavLink>
        )}
        <JobActivo />
        <NavLink to="/ajustes" data-testid="nav-ajustes" className={({ isActive }) => cx(s.perfil, isActive && s.activo)}>
          <span className={s.avatar} aria-hidden>
            {nombre.slice(0, 1).toUpperCase()}
          </span>
          <span className={s.perfilTexto}>
            <span className={s.perfilNombre} data-testid="nav-canal-activo">
              {nombre}
            </span>
            <span className={s.perfilSub}>{autorizado ? "Canal autorizado" : "Sin autorizar"} · Ajustes</span>
          </span>
        </NavLink>
      </div>
    </nav>
  );
}
