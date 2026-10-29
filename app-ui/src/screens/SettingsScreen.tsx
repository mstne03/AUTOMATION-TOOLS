/** Ajustes (docs/pantallas.md → Ajustes): secciones con guardado automático (cada cambio se envía
 *  al sidecar al momento y avisa con un toast), sin botón "Guardar" al final. */
import { Folder, Plus, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { useClient } from "../api/context";
import { usePutSettings, useSettings, useYoutubeStatus } from "../api/queries";
import type { AllowedDir, Model, SettingsPatch } from "../api/types";
import { descripcionModelo, nombreModelo, precioModelo } from "../chat/modelos";
import { elegirCarpeta } from "../dialogo";
import { EnlaceExterno } from "../enlaces";
import { setTema, useTema, type Tema } from "../state/tema";
import { Button, Chip, ConfirmDialog, Dialog, Estado, Field, IconButton, Input, Mono, SegmentedControl, Select, toast } from "../ui";
import { cx } from "../ui/cx";
import { CuotaLista } from "./CuotaLista";
import { avisarCanalAutorizado, CREDENCIALES, ImportarClientSecret, PUBLICO } from "./ProyectoGoogle";
import s from "./SettingsScreen.module.css";

const SECCIONES = [
  ["general", "General"],
  ["canales", "Canales de YouTube"],
  ["carpetas", "Carpetas permitidas"],
  ["clave", "Clave de Anthropic"],
  ["avanzado", "Avanzado"],
] as const;

const IDIOMAS: Array<[string, string]> = [
  ["es", "Español"],
  ["en", "Inglés"],
  ["", "Detectar"],
];

/** Nombre legible del almacén de secretos del sidecar (UI-16). */
export function nombreAlmacen(almacen: string): string {
  if (/keyring/i.test(almacen)) return "Administrador de credenciales de Windows";
  if (/file/i.test(almacen)) return "Fichero local (modo de pruebas)";
  return almacen;
}

const PERFIL_VALIDO = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CANCELADA = "Autorización cancelada."; // detalle del sidecar al cortar el flujo OAuth

export function SettingsScreen() {
  const settings = useSettings();
  if (settings.isPending) return <Estado>Cargando ajustes…</Estado>;
  if (settings.isError) return <Estado error>Error: {settings.error.message}</Estado>;
  return <Ajustes />;
}

function Ajustes() {
  const client = useClient();
  const qc = useQueryClient();
  const navegar = useNavigate();
  const { data: ajustes } = useSettings();
  const s0 = ajustes!;
  const yt = useYoutubeStatus();
  const put = usePutSettings();
  const tema = useTema((t) => t.tema);
  const [activa, setActiva] = useState<string>("general");
  const [errorGuardado, setErrorGuardado] = useState<string | null>(null);

  const [apiKey, setApiKey] = useState("");
  const [reemplazando, setReemplazando] = useState(false);
  const [borrandoClave, setBorrandoClave] = useState(false);
  const [nuevoPath, setNuevoPath] = useState("");
  const [nuevoLang, setNuevoLang] = useState("es");
  const [errorCarpeta, setErrorCarpeta] = useState<string | null>(null);
  const [anadiendo, setAnadiendo] = useState(false);
  const [nombreCanal, setNombreCanal] = useState("");
  const [sustituyendo, setSustituyendo] = useState(false);
  const [quitandoProyecto, setQuitandoProyecto] = useState(false);

  /** Guarda al momento lo que cambia y avisa. Cambiar de perfil valida el token OAuth en el sidecar. */
  const guardar = (patch: SettingsPatch, aviso: string, despues?: () => void) => {
    setErrorGuardado(null);
    put.mutate(patch, {
      onSuccess: () => {
        toast({ title: aviso });
        despues?.();
      },
      onError: (e) => {
        setErrorGuardado(e.message);
        toast({ title: "No se pudo guardar", description: e.message, tone: "error" });
      },
    });
  };

  const reautorizar = useMutation({
    mutationFn: (perfil: string) => client.youtubeAuth({ profile: perfil, reauthorize: true }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["youtube"] });
      avisarCanalAutorizado(r);
    },
    onError: (e) => toast(e.message === CANCELADA ? { title: CANCELADA } : { title: "No se pudo autorizar", description: e.message, tone: "error" }),
  });
  /** Si se cierra la pestaña de Google, el sidecar esperaría hasta su límite: esto lo corta y la
   *  petición pendiente falla con "Autorización cancelada.". */
  const cancelarAutorizacion = () => void client.youtubeAuthCancel().catch(() => undefined);

  const anadirCanal = useMutation({
    mutationFn: async (perfil: string) => {
      const auth = await client.youtubeAuth({ profile: perfil, reauthorize: true });
      return { auth, datos: await client.putSettings({ profile: perfil }) };
    },
    onSuccess: ({ auth, datos }) => {
      qc.setQueryData(["settings"], datos);
      void qc.invalidateQueries({ queryKey: ["youtube"] });
      setAnadiendo(false);
      setNombreCanal("");
      avisarCanalAutorizado(auth, "Canal añadido y en uso");
    },
  });

  /** Quitar el proyecto de Google desautoriza todos los canales (sus tokens son de ese cliente OAuth). */
  const quitarProyecto = useMutation({
    mutationFn: () => client.removeClientSecret(),
    onSuccess: (r) => {
      qc.setQueryData(["settings"], r);
      void qc.invalidateQueries({ queryKey: ["youtube"] });
      toast({ title: "Proyecto de Google quitado", description: r.desautorizados.length ? `Desautorizados: ${r.desautorizados.join(", ")}.` : undefined });
    },
    onError: (e) => toast({ title: "No se pudo quitar el proyecto", description: e.message, tone: "error" }),
  });

  /** Cerrar el diálogo (Cancelar o Escape) también corta la autorización si está esperando al navegador. */
  const cerrarAlta = () => {
    if (anadirCanal.isPending) cancelarAutorizacion();
    setAnadiendo(false);
  };

  const perfilesAutorizados = yt.data?.auth.profiles ?? [];
  const perfiles = [...new Set([...perfilesAutorizados, s0.profile])];
  const nombreValido = PERFIL_VALIDO.test(nombreCanal.trim().toLowerCase());
  const autorizado = yt.data?.auth.authenticated ?? false;
  const canales = yt.data?.auth.channels ?? {};
  const proyecto = s0.google_project;
  const dirs = s0.allowed_dirs;

  const irA = (id: string) => {
    setActiva(id);
    document.getElementById(`ajustes-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const anadirDir = (path: string, language: string) => {
    if (dirs.some((d) => d.path.toLowerCase() === path.toLowerCase())) {
      setErrorCarpeta("Esa carpeta ya está en la lista.");
      return;
    }
    setErrorCarpeta(null);
    guardar({ allowed_dirs: [...dirs, { path, language: language || null }] }, "Carpeta añadida", () => {
      setNuevoPath("");
    });
  };
  const elegir = async () => {
    setErrorCarpeta(null);
    try {
      const ruta = await elegirCarpeta(dirs[0]?.path ?? "");
      if (ruta) anadirDir(ruta, nuevoLang);
    } catch (e) {
      setErrorCarpeta(String((e as Error)?.message ?? e));
    }
  };
  const cambiarIdioma = (i: number, lang: string) =>
    guardar({ allowed_dirs: dirs.map((d, j): AllowedDir => (j === i ? { ...d, language: lang || null } : d)) }, "Idioma guardado");
  const quitarDir = (i: number) => guardar({ allowed_dirs: dirs.filter((_, j) => j !== i) }, "Carpeta quitada");

  const guardarKey = (e: FormEvent) => {
    e.preventDefault();
    if (!apiKey) return;
    guardar({ anthropic_api_key: apiKey }, "Clave guardada", () => setReemplazando(false));
    setApiKey(""); // se envía una vez y no se vuelve a mostrar
  };

  const mostrarCampoClave = !s0.has_anthropic_key || reemplazando;

  return (
    <div className={s.pantalla} data-testid="ajustes-form">
      <h1 className={s.titulo}>Ajustes</h1>
      <div className={s.cuerpo}>
        <nav className={s.subnav} aria-label="Secciones de ajustes" data-testid="ajustes-subnav">
          {SECCIONES.map(([id, nombre]) => (
            <button key={id} type="button" className={cx(s.subenlace, activa === id && s.subactivo)} aria-current={activa === id ? "true" : undefined} data-testid={`ajustes-nav-${id}`} onClick={() => irA(id)}>
              {nombre}
            </button>
          ))}
        </nav>

        <div className={s.secciones}>
          {errorGuardado && (
            <p className={s.error} data-testid="ajustes-error" role="alert">
              {errorGuardado}
            </p>
          )}

          <section id="ajustes-general" className={s.seccion} aria-labelledby="s-modelo">
            <div>
              <h2 id="s-modelo" className={s.h2}>
                Modelo del agente
              </h2>
              <p className={s.ayuda}>Se aplica a la próxima respuesta. Los cambios se guardan solos.</p>
            </div>
            <div role="radiogroup" aria-label="Modelo" className={s.modelos} data-testid="ajustes-model">
              {s0.models.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={s0.model === m} className={cx(s.modelo, s0.model === m && s.modeloActivo)} data-testid={`ajustes-model-${m}`} disabled={put.isPending} onClick={() => s0.model !== m && guardar({ model: m as Model }, "Modelo guardado")}>
                  <span className={s.modeloNombre}>{nombreModelo(m)}</span>
                  <span className={s.ayuda}>{descripcionModelo(m)}</span>
                  <span className={s.precio}>{precioModelo(m)}</span>
                </button>
              ))}
            </div>
            <div className={s.apariencia}>
              <span className={s.aparienciaTitulo}>Apariencia</span>
              <SegmentedControl
                aria-label="Apariencia"
                data-testid="ajustes-tema"
                value={tema}
                onChange={(t: Tema) => setTema(t)}
                options={[
                  { value: "system", label: "Sistema" },
                  { value: "light", label: "Claro" },
                  { value: "dark", label: "Oscuro" },
                ]}
              />
            </div>
          </section>

          <section id="ajustes-canales" className={s.seccion} aria-labelledby="s-canales">
            <div className={s.cabecera}>
              <div className={s.flex}>
                <h2 id="s-canales" className={s.h2}>
                  Canales de YouTube
                </h2>
                <p className={s.ayuda}>Cada canal es un perfil con su propia autorización; todos usan el mismo proyecto de Google Cloud y comparten su cuota diaria.</p>
              </div>
              <Button
                icon={Plus}
                data-testid="ajustes-yt-anadir"
                onClick={() => {
                  anadirCanal.reset(); // sin el error ni el estado de un intento anterior
                  setAnadiendo(true);
                }}
              >
                Añadir canal
              </Button>
            </div>
            <div className={s.proyecto} data-testid="ajustes-google-proyecto">
              <span className={s.perfilTexto}>
                <span className={s.perfilNombre}>Proyecto de Google Cloud</span>
                <span className={s.ayuda}>
                  {proyecto ? (
                    <>
                      <Mono>{proyecto.project_id ?? "sin nombre"}</Mono> · cliente <Mono>{proyecto.client_id}</Mono>
                    </>
                  ) : (
                    "Sin proyecto: importa el client_secret.json para poder autorizar canales."
                  )}
                </span>
              </span>
              <Button size="sm" variant={proyecto ? "secondary" : "primary"} data-testid="ajustes-google-sustituir" onClick={() => setSustituyendo(true)}>
                {proyecto ? "Sustituir…" : "Importar client_secret.json"}
              </Button>
              {proyecto && (
                <Button size="sm" variant="ghost" data-testid="ajustes-google-eliminar" loading={quitarProyecto.isPending} onClick={() => setQuitandoProyecto(true)}>
                  Quitar
                </Button>
              )}
            </div>
            <ul className={s.perfiles} data-testid="ajustes-profile">
              {perfiles.map((p) => {
                const enUso = p === s0.profile;
                const canal = canales[p];
                return (
                  <li key={p} className={cx(s.perfil, enUso && s.perfilActivo)} data-testid={`ajustes-profile-${p}`} aria-current={enUso ? "true" : undefined}>
                    <span className={s.avatar} aria-hidden>
                      {(canal?.title ?? p).slice(0, 1).toUpperCase()}
                    </span>
                    <span className={s.perfilTexto}>
                      {/* El título del canal viene de YouTube: se pinta como texto, nunca como HTML. */}
                      <span className={s.perfilNombre} data-testid={`ajustes-canal-${p}`}>
                        {canal?.title ?? p}
                      </span>
                      <span className={s.ayuda}>{[canal ? `Perfil ${p}` : null, canal?.handle, enUso ? "En uso" : "Guardado"].filter(Boolean).join(" · ")}</span>
                    </span>
                    {enUso && (
                      <span data-testid="ajustes-yt-estado">
                        {yt.isPending ? (
                          "…"
                        ) : (
                          <Chip tone={autorizado ? "success" : "write"}>{autorizado ? "Autorizado" : "Sin autorizar"}</Chip>
                        )}
                      </span>
                    )}
                    {enUso ? (
                      <>
                        <Button size="sm" data-testid="ajustes-yt-reauth" loading={reautorizar.isPending && reautorizar.variables === p} onClick={() => reautorizar.mutate(p)}>
                          {reautorizar.isPending ? "Se ha abierto el navegador…" : "Volver a autorizar"}
                        </Button>
                        {reautorizar.isPending && (
                          <Button size="sm" variant="ghost" data-testid="ajustes-yt-reauth-cancelar" onClick={cancelarAutorizacion}>
                            Cancelar
                          </Button>
                        )}
                      </>
                    ) : (
                      <Button size="sm" data-testid={`ajustes-yt-usar-${p}`} disabled={put.isPending} onClick={() => guardar({ profile: p }, `Perfil «${p}» en uso`)}>
                        Usar este
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <section id="ajustes-carpetas" className={s.seccion} aria-labelledby="s-carpetas">
            <div className={s.cabecera}>
              <div className={s.flex}>
                <h2 id="s-carpetas" className={s.h2}>
                  Carpetas permitidas
                </h2>
                <p className={s.ayuda}>El agente solo puede subir o transcribir vídeos de estas carpetas.</p>
              </div>
              <Button icon={Folder} data-testid="ajustes-dir-elegir" onClick={() => void elegir()}>
                Elegir carpeta…
              </Button>
            </div>
            <ul className={s.carpetas} data-testid="ajustes-dirs">
              {dirs.length === 0 && <li className={s.ayuda}>Aún no hay carpetas permitidas.</li>}
              {dirs.map((d, i) => (
                <li key={d.path} className={s.carpeta} data-testid="ajustes-dir">
                  <Folder aria-hidden size="1.15em" className={s.icono} />
                  <Mono className={s.ruta}>{d.path}</Mono>
                  <label className={s.idioma}>
                    <span className={s.ayuda}>Idioma</span>
                    <Select compact value={d.language ?? ""} aria-label={`Idioma de ${d.path}`} onChange={(e) => cambiarIdioma(i, e.target.value)} disabled={put.isPending}>
                      {IDIOMAS.map(([v, n]) => (
                        <option key={v} value={v}>
                          {n}
                        </option>
                      ))}
                      {d.language && !IDIOMAS.some(([v]) => v === d.language) && <option value={d.language}>{d.language}</option>}
                    </Select>
                  </label>
                  <IconButton icon={X} size="xs" variant="ghost" aria-label={`Quitar la carpeta ${d.path}`} disabled={put.isPending} onClick={() => quitarDir(i)} />
                </li>
              ))}
            </ul>
            <form
              className={s.altaCarpeta}
              onSubmit={(e) => {
                e.preventDefault();
                if (nuevoPath.trim()) anadirDir(nuevoPath.trim(), nuevoLang);
              }}
            >
              <Field label="Añadir una ruta a mano" className={s.flex} error={errorCarpeta ?? undefined}>
                <Input mono data-testid="ajustes-dir-path" placeholder="C:\Users\…\Videos" value={nuevoPath} onChange={(e) => setNuevoPath(e.target.value)} />
              </Field>
              <Field label="Idioma">
                <Select data-testid="ajustes-dir-lang" value={nuevoLang} onChange={(e) => setNuevoLang(e.target.value)}>
                  {IDIOMAS.map(([v, n]) => (
                    <option key={v} value={v}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" data-testid="ajustes-dir-add" disabled={!nuevoPath.trim() || put.isPending}>
                Añadir
              </Button>
            </form>
          </section>

          <section id="ajustes-clave" className={s.seccion} aria-labelledby="s-clave">
            <div>
              <h2 id="s-clave" className={s.h2}>
                Clave de Anthropic
              </h2>
              <p className={s.ayuda}>Se guarda en {nombreAlmacen(s0.secret_store)} y nunca se vuelve a mostrar.</p>
            </div>
            <p className={s.estadoClave} data-testid="ajustes-key-estado">
              {s0.has_anthropic_key ? (
                <>
                  <Mono>sk-ant-••••••••••••</Mono> · Guardada en {s0.secret_store}
                </>
              ) : (
                "Sin clave"
              )}
            </p>
            {mostrarCampoClave && (
              <form className={s.altaClave} onSubmit={guardarKey}>
                <Field label={s0.has_anthropic_key ? "Nueva clave" : "Clave de la API"} className={s.flex}>
                  <Input type="password" mono data-testid="ajustes-key" placeholder="sk-ant-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
                </Field>
                <Button type="submit" variant="primary" data-testid="ajustes-key-guardar" disabled={!apiKey || put.isPending}>
                  Guardar clave
                </Button>
                {reemplazando && (
                  <Button
                    onClick={() => {
                      setReemplazando(false);
                      setApiKey("");
                    }}
                  >
                    Cancelar
                  </Button>
                )}
              </form>
            )}
            {s0.has_anthropic_key && !reemplazando && (
              <div className={s.acciones}>
                <Button data-testid="ajustes-key-reemplazar" onClick={() => setReemplazando(true)}>
                  Reemplazar
                </Button>
                <Button variant="danger" data-testid="ajustes-key-borrar" disabled={put.isPending} onClick={() => setBorrandoClave(true)}>
                  Borrar
                </Button>
              </div>
            )}
          </section>

          <section id="ajustes-avanzado" className={s.seccion} aria-labelledby="s-avanzado">
            <h2 id="s-avanzado" className={s.h2}>
              Avanzado
            </h2>
            <div className={s.subseccion}>
              <h3 className={s.h3}>Cuota de YouTube (hoy)</h3>
              {yt.data ? <CuotaLista buckets={yt.data.quota.buckets} /> : <p className={s.ayuda}>…</p>}
            </div>
            <div className={s.subseccion}>
              <h3 className={s.h3}>Información</h3>
              <p className={s.info}>
                Directorio de estado: <Mono>{s0.state_dir}</Mono>
                <br />
                Almacén de secretos: {nombreAlmacen(s0.secret_store)} (<Mono>{s0.secret_store}</Mono>)
              </p>
            </div>
            <div className={s.subseccion}>
              <h3 className={s.h3}>Asistente de configuración</h3>
              <p className={s.ayuda}>Vuelve a recorrer la bienvenida: clave, proyecto de Google Cloud, autorización del canal y base de conocimiento.</p>
              <div>
                <Button data-testid="ajustes-asistente" onClick={() => navegar("/onboarding")}>
                  Abrir el asistente
                </Button>
              </div>
            </div>
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={borrandoClave}
        onOpenChange={setBorrandoClave}
        title="¿Borrar la clave de Anthropic?"
        description="El agente dejará de responder hasta que introduzcas otra clave."
        confirmLabel="Borrar clave"
        tone="danger"
        onConfirm={() => guardar({ anthropic_api_key: "" }, "Clave borrada")}
      />

      <ConfirmDialog
        open={quitandoProyecto}
        onOpenChange={setQuitandoProyecto}
        title="¿Quitar el proyecto de Google?"
        description={`Se desautorizarán todos los canales${perfilesAutorizados.length ? ` (${perfilesAutorizados.join(", ")})` : ""}. Para volver a usarlos tendrás que importar un client_secret.json y autorizarlos de nuevo.`}
        confirmLabel="Quitar y desautorizar"
        tone="danger"
        onConfirm={() => quitarProyecto.mutate()}
      />

      <Dialog
        open={sustituyendo}
        onOpenChange={setSustituyendo}
        title={proyecto ? "Sustituir el proyecto de Google" : "Importar el proyecto de Google"}
        description="El client_secret.json de un ID de cliente OAuth de tipo «Aplicación de escritorio». Si es de otro proyecto, los canales autorizados tendrán que volver a autorizarse."
      >
        <div className={s.importar}>
          <ImportarClientSecret onImportado={() => setSustituyendo(false)} />
        </div>
      </Dialog>

      <Dialog
        open={anadiendo}
        onOpenChange={(a) => (a ? setAnadiendo(true) : cerrarAlta())}
        title="Añadir un canal de YouTube"
        description="Elige un nombre para el perfil. Se abrirá el navegador para que autorices ese canal y quedará en uso."
        footer={
          <>
            <Button variant="ghost" onClick={cerrarAlta}>
              Cancelar
            </Button>
            <Button variant="primary" data-testid="ajustes-yt-anadir-ok" disabled={!nombreValido || !s0.has_client_secret} loading={anadirCanal.isPending} onClick={() => anadirCanal.mutate(nombreCanal.trim().toLowerCase())}>
              {anadirCanal.isPending ? "Se ha abierto el navegador…" : "Autorizar canal"}
            </Button>
          </>
        }
      >
        <Field label="Nombre del perfil" help="Letras minúsculas, números, guion y guion bajo (máx. 32)." error={nombreCanal !== "" && !nombreValido ? "Nombre no válido" : (anadirCanal.error?.message ?? undefined)}>
          <Input data-testid="ajustes-yt-nombre" value={nombreCanal} onChange={(e) => setNombreCanal(e.target.value)} placeholder="smooth" autoComplete="off" disabled={anadirCanal.isPending} />
        </Field>
        {!s0.has_client_secret && (
          <div className={s.aviso} data-testid="ajustes-yt-sin-proyecto" role="alert">
            <p>Para autorizar un canal hace falta el proyecto de Google Cloud de la app (su client_secret.json).</p>
            <Button
              size="sm"
              onClick={() => {
                setAnadiendo(false);
                setSustituyendo(true);
              }}
            >
              Importar client_secret.json
            </Button>
          </div>
        )}
        {anadirCanal.isPending && (
          <p className={s.ayuda} data-testid="ajustes-yt-ayuda-google">
            Elige en el navegador la cuenta de Google de ese canal. Si Google bloquea el acceso, la cuenta no es usuario de prueba del proyecto: añádela o publica la app en <EnlaceExterno href={PUBLICO}>Público</EnlaceExterno>.
          </p>
        )}
        {anadirCanal.error && anadirCanal.error.message !== CANCELADA && s0.has_client_secret && (
          <div className={s.aviso} data-testid="ajustes-yt-error-ayuda">
            <p>
              Si el problema es el proyecto de Google, revisa sus <EnlaceExterno href={CREDENCIALES}>credenciales</EnlaceExterno> o importa otro client_secret.json.
            </p>
            <Button
              size="sm"
              onClick={() => {
                setAnadiendo(false);
                setSustituyendo(true);
              }}
            >
              Sustituir client_secret.json
            </Button>
          </div>
        )}
      </Dialog>
    </div>
  );
}
