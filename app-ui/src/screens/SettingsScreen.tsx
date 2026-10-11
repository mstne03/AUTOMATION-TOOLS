/** Ajustes (docs/pantallas.md → Ajustes). */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useClient } from "../api/context";
import { usePutSettings, useSettings, useYoutubeStatus } from "../api/queries";
import type { AllowedDir, Model, SettingsPatch } from "../api/types";

export function SettingsScreen() {
  const settings = useSettings();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!ok) return;
    const t = setTimeout(() => setOk(false), 3000);
    return () => clearTimeout(t);
  }, [ok]);
  if (settings.isPending) return <p className="estado">Cargando ajustes…</p>;
  if (settings.isError) return <p className="estado error">Error: {settings.error.message}</p>;
  // El formulario se remonta con cada respuesta del sidecar (estado local = último guardado);
  // el aviso "Guardado" vive fuera para sobrevivir al remontaje.
  return <SettingsForm key={JSON.stringify(settings.data)} ok={ok} setOk={setOk} />;
}

function SettingsForm({ ok, setOk }: { ok: boolean; setOk: (v: boolean) => void }) {
  const client = useClient();
  const qc = useQueryClient();
  const { data: s } = useSettings();
  const yt = useYoutubeStatus();
  const put = usePutSettings();
  const [model, setModel] = useState<Model>(s!.model);
  const [dirs, setDirs] = useState<AllowedDir[]>(s!.allowed_dirs);
  const [profile, setProfile] = useState(s!.profile);
  const [nuevoPath, setNuevoPath] = useState("");
  const [nuevoLang, setNuevoLang] = useState("");
  const [apiKey, setApiKey] = useState("");

  const cambios =
    model !== s!.model || profile !== s!.profile || JSON.stringify(dirs) !== JSON.stringify(s!.allowed_dirs);

  const guardar = (e: FormEvent) => {
    e.preventDefault();
    // Solo lo que cambia: cambiar de perfil valida el token OAuth en el sidecar.
    const patch: SettingsPatch = {};
    if (model !== s!.model) patch.model = model;
    if (profile !== s!.profile) patch.profile = profile;
    if (JSON.stringify(dirs) !== JSON.stringify(s!.allowed_dirs)) patch.allowed_dirs = dirs;
    put.mutate(patch, { onSuccess: () => setOk(true) });
  };
  const guardarKey = () => {
    if (!apiKey) return;
    put.mutate({ anthropic_api_key: apiKey }, { onSuccess: () => setOk(true) });
    setApiKey(""); // se envía una vez y no se vuelve a mostrar
  };
  const borrarKey = () => put.mutate({ anthropic_api_key: "" }, { onSuccess: () => setOk(true) });

  const reauth = useMutation({
    mutationFn: () => client.youtubeAuth({ profile, reauthorize: true }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["youtube", "status"] }),
  });

  const error = put.error?.message ?? reauth.error?.message;

  return (
    <form className="ajustes" data-testid="ajustes-form" onSubmit={guardar}>
      <h1>Ajustes</h1>

      <section>
        <h2>Modelo</h2>
        <select data-testid="ajustes-model" value={model} onChange={(e) => setModel(e.target.value as Model)}>
          {s!.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </section>

      <section>
        <h2>Clave de Anthropic</h2>
        <p data-testid="ajustes-key-estado">{s!.has_anthropic_key ? `Guardada en ${s!.secret_store}` : "Sin clave"}</p>
        <div className="fila">
          <input
            type="password"
            data-testid="ajustes-key"
            placeholder="sk-ant-…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
          <button type="button" data-testid="ajustes-key-guardar" onClick={guardarKey} disabled={!apiKey || put.isPending}>
            Guardar clave
          </button>
          {s!.has_anthropic_key && (
            <button type="button" data-testid="ajustes-key-borrar" onClick={borrarKey} disabled={put.isPending}>
              Borrar clave
            </button>
          )}
        </div>
      </section>

      <section>
        <h2>Carpetas permitidas</h2>
        <p className="nota">El agente solo puede subir o transcribir ficheros de estas carpetas.</p>
        <table data-testid="ajustes-dirs">
          <thead>
            <tr>
              <th>Ruta</th>
              <th>Idioma</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {dirs.map((d, i) => (
              <tr key={i} data-testid="ajustes-dir">
                <td>
                  <code>{d.path}</code>
                </td>
                <td>{d.language ?? "—"}</td>
                <td>
                  <button type="button" onClick={() => setDirs(dirs.filter((_, j) => j !== i))}>
                    Quitar
                  </button>
                </td>
              </tr>
            ))}
            <tr>
              <td>
                <input data-testid="ajustes-dir-path" placeholder="C:\Users\…\Videos" value={nuevoPath} onChange={(e) => setNuevoPath(e.target.value)} />
              </td>
              <td>
                <input data-testid="ajustes-dir-lang" placeholder="es" size={4} value={nuevoLang} onChange={(e) => setNuevoLang(e.target.value)} />
              </td>
              <td>
                <button
                  type="button"
                  data-testid="ajustes-dir-add"
                  disabled={!nuevoPath.trim()}
                  onClick={() => {
                    setDirs([...dirs, { path: nuevoPath.trim(), language: nuevoLang.trim() || null }]);
                    setNuevoPath("");
                    setNuevoLang("");
                  }}
                >
                  Añadir
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>Perfil de YouTube</h2>
        <div className="fila">
          <select data-testid="ajustes-profile" value={profile} onChange={(e) => setProfile(e.target.value)}>
            {[...new Set([...(yt.data?.auth.profiles ?? []), profile])].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <span data-testid="ajustes-yt-estado">
            {yt.isPending ? "…" : yt.data?.auth.authenticated ? "Autorizado" : "Sin autorizar"}
          </span>
          <button type="button" data-testid="ajustes-yt-reauth" onClick={() => reauth.mutate()} disabled={reauth.isPending}>
            {reauth.isPending ? "Se ha abierto el navegador…" : "Volver a autorizar"}
          </button>
        </div>
      </section>

      <section>
        <h2>Cuota de YouTube (hoy)</h2>
        {yt.data && <Cuota buckets={yt.data.quota.buckets} />}
      </section>

      <section>
        <h2>Información</h2>
        <p>
          Directorio de estado: <code>{s!.state_dir}</code>
          <br />
          Almacén de secretos: <code>{s!.secret_store}</code>
        </p>
      </section>

      <div className="fila">
        <button type="submit" data-testid="ajustes-guardar" disabled={!cambios || put.isPending}>
          Guardar
        </button>
        {ok && <span data-testid="ajustes-ok">Guardado</span>}
        {error && (
          <span className="error" data-testid="ajustes-error">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

export function Cuota({ buckets }: { buckets: Record<string, { used: number; limit: number }> }) {
  return (
    <div className="cuota">
      {Object.entries(buckets).map(([b, v]) => (
        <label key={b} data-testid={`cuota-${b}`}>
          <span>
            {b}: {v.used} / {v.limit}
          </span>
          <progress value={v.used} max={v.limit} />
        </label>
      ))}
    </div>
  );
}
