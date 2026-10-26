/** Proyecto de Google Cloud de la app (SEO-101/SEO-96): un solo client_secret.json para todos los
 *  canales, un token por canal. Lo comparten Onboarding (paso Google Cloud) y Ajustes (Sustituir…). */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileCheck, FileJson } from "lucide-react";
import { useEffect, useState, type DragEvent } from "react";
import { ApiError } from "../api/client";
import { useClient } from "../api/context";
import { useSettings } from "../api/queries";
import type { CanalYouTube, SettingsTrasProyecto, YouTubeAuthOut } from "../api/types";
import { elegirClientSecret, enTauri } from "../dialogo";
import { Button, ConfirmDialog, Field, Input, Mono, Textarea, toast } from "../ui";
import { cx } from "../ui/cx";
import s from "./ProyectoGoogle.module.css";

export const CONSOLE = "https://console.cloud.google.com/apis/library/youtube.googleapis.com";
export const CREDENCIALES = "https://console.cloud.google.com/apis/credentials";
// En estado "Prueba" solo entran los usuarios de prueba y los refresh tokens caducan a los 7 días.
export const PUBLICO = "https://console.cloud.google.com/auth/audience";

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

/** "Canal A (@a)", o null si el sidecar aún no sabe qué canal autorizó el perfil. */
export function nombreCanal(c: CanalYouTube | null | undefined): string | null {
  if (!c?.title) return c?.handle ?? null;
  return c.handle ? `${c.title} (${c.handle})` : c.title;
}

/** Aviso tras autorizar; si ese canal ya estaba en otro perfil, se dice (gastaría cuota por duplicado). */
export function avisarCanalAutorizado(r: YouTubeAuthOut, titulo = "Canal autorizado") {
  const canal = nombreCanal(r.detail.channel);
  if (r.duplicated_in.length) {
    toast({
      title: titulo,
      description: `${canal ?? "Este canal"} ya estaba autorizado en el perfil ${r.duplicated_in.join(", ")}: tienes el mismo canal dos veces.`,
      tone: "warning",
    });
  } else {
    toast({ title: titulo, description: canal ?? undefined });
  }
}

type Cuerpo = { json_text?: string; path?: string };
/** Lo que se envía al sidecar más el nombre con el que se confirma la importación. */
type Peticion = Cuerpo & { replace?: boolean; nombre: string };

const nombreDeRuta = (ruta: string) => ruta.split(/[\\/]/).pop() || ruta;

/** Importa el client_secret.json del proyecto de Google (SEO-106, SEO-97). Elegir o soltar el fichero
 *  lo importa en el acto: no hay un estado «elegido pero sin importar» que haga creer que el proyecto
 *  nuevo ya está activo. Pegar el JSON o escribir la ruta sí piden «Importar», y mientras tanto se
 *  avisa de que sigue activo el proyecto anterior (`onPendiente` deja que el asistente no avance).
 *  Si el fichero es de otro proyecto y hay canales autorizados, el sidecar responde 409 y se pide
 *  confirmación antes de sustituirlo. */
export function ImportarClientSecret({ onImportado, onPendiente }: { onImportado?: (r: SettingsTrasProyecto) => void; onPendiente?: (pendiente: boolean) => void }) {
  const client = useClient();
  const qc = useQueryClient();
  const activo = useSettings().data?.google_project ?? null;
  const [jsonText, setJsonText] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [arrastrando, setArrastrando] = useState(false);
  const [conflicto, setConflicto] = useState<{ peticion: Peticion; detalle: string } | null>(null);
  /** Nombre del último fichero importado aquí, para la confirmación. */
  const [importado, setImportado] = useState<string | null>(null);

  const pendiente = jsonText.trim() !== "" || path.trim() !== "";
  useEffect(() => onPendiente?.(pendiente), [pendiente, onPendiente]);

  const importar = useMutation({
    mutationFn: ({ nombre: _nombre, ...body }: Peticion) => client.importClientSecret(body),
    onSuccess: (r, peticion) => {
      qc.setQueryData(["settings"], r);
      void qc.invalidateQueries({ queryKey: ["youtube"] });
      setJsonText("");
      setPath("");
      setError(null);
      setImportado(peticion.nombre);
      toast(
        r.desautorizados.length
          ? { title: "Proyecto de Google sustituido", description: `Vuelve a autorizar: ${r.desautorizados.join(", ")}.`, tone: "warning" }
          : { title: "Credenciales de Google importadas", description: r.google_project?.project_id ?? undefined },
      );
      onImportado?.(r);
    },
    onError: (e, peticion) => {
      if (e instanceof ApiError && e.status === 409 && !peticion.replace) setConflicto({ peticion, detalle: e.detail });
      else setError(e.message);
    },
  });

  const enviar = (peticion: Peticion) => {
    setError(null);
    setImportado(null);
    importar.mutate(peticion);
  };

  /** Botón «Importar»: solo para el JSON pegado o la ruta escrita a mano. */
  const onImportar = () => {
    if (jsonText.trim()) {
      const err = validarClientSecret(jsonText);
      if (err) return setError(err);
      return enviar({ json_text: jsonText, nombre: "El JSON pegado" });
    }
    if (path.trim()) return enviar({ path: path.trim(), nombre: nombreDeRuta(path.trim()) });
    setError("Pega el JSON o escribe la ruta del fichero (o elige el fichero arriba).");
  };

  /** Fichero elegido en el navegador o soltado: se valida y se importa sin más pasos. */
  const leerFichero = async (f: File) => {
    const texto = await f.text();
    const err = validarClientSecret(texto);
    if (err) {
      setImportado(null);
      return setError(err);
    }
    enviar({ json_text: texto, nombre: f.name });
  };
  const soltar = (e: DragEvent) => {
    e.preventDefault();
    setArrastrando(false);
    const f = e.dataTransfer.files[0];
    if (f) void leerFichero(f);
  };
  /** Explorador nativo (Rust): devuelve la ruta y el sidecar lee el fichero. */
  const elegirFichero = async () => {
    try {
      const ruta = await elegirClientSecret();
      if (ruta) enviar({ path: ruta, nombre: nombreDeRuta(ruta) });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const proyecto = importar.data?.google_project;
  return (
    <>
      {activo && (
        <p className={s.ayuda} data-testid="google-activo">
          Proyecto activo: <Mono>{activo.project_id ?? "sin nombre"}</Mono> · cliente <Mono>{activo.client_id}</Mono>. Importar otro lo sustituye.
        </p>
      )}
      <div
        className={cx(s.soltar, arrastrando && s.soltarActivo)}
        data-testid="google-soltar"
        onDragOver={(e) => {
          e.preventDefault();
          setArrastrando(true);
        }}
        onDragLeave={() => setArrastrando(false)}
        onDrop={soltar}
      >
        <FileJson aria-hidden size="1.6em" />
        <span>
          Suelta aquí el <Mono>client_secret.json</Mono> descargado: se importa al momento
        </span>
        <span className={s.suave}>o</span>
        {/* Un solo selector: en la app, el explorador nativo (Rust); fuera de Tauri (E2E, pnpm dev),
            el del navegador. Los dos a la vez se contradecían al usar uno de ellos. */}
        {enTauri() ? (
          <Button size="sm" data-testid="google-elegir" loading={importar.isPending} onClick={() => void elegirFichero()}>
            Elegir fichero…
          </Button>
        ) : (
          <input type="file" accept=".json,application/json" aria-label="Elegir el client_secret.json" data-testid="google-fichero" onChange={(e) => e.target.files?.[0] && void leerFichero(e.target.files[0])} />
        )}
      </div>
      {importado && proyecto && !importar.isPending && (
        <p className={s.ok} data-testid="google-importado" role="status">
          <FileCheck aria-hidden size="1.2em" />
          <span>
            {importado} importado · proyecto <Mono>{proyecto.project_id ?? "sin nombre"}</Mono> · cliente <Mono>{proyecto.client_id}</Mono>
          </span>
        </p>
      )}

      <Field label="O pega aquí el contenido del JSON">
        <Textarea data-testid="google-json" rows={4} placeholder='{"installed": {"client_id": …}}' value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
      </Field>
      <Field label="O escribe la ruta del fichero">
        <Input mono data-testid="google-path" placeholder="C:\Users\…\client_secret_….json" value={path} onChange={(e) => setPath(e.target.value)} />
      </Field>
      <div className={s.fila}>
        <Button variant="primary" data-testid="google-importar" loading={importar.isPending} onClick={onImportar}>
          Importar
        </Button>
        {pendiente && (
          <p className={s.aviso} data-testid="google-pendiente" role="status">
            {jsonText.trim() ? "Este JSON" : "Esta ruta"} aún no se ha importado:{" "}
            {activo ? `sigue activo el proyecto ${activo.project_id ?? "anterior"}` : "todavía no hay ningún proyecto activo"}. Pulsa «Importar».
          </p>
        )}
      </div>
      <p className={s.ayuda}>Se guarda cifrado; el fichero original puedes borrarlo.</p>
      {error && (
        <p className={s.error} data-testid="google-error" role="alert">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={conflicto !== null}
        onOpenChange={(a) => !a && setConflicto(null)}
        title="¿Sustituir el proyecto de Google?"
        description={conflicto?.detalle}
        confirmLabel="Sustituir y desautorizar"
        tone="danger"
        onConfirm={() => {
          if (conflicto) importar.mutate({ ...conflicto.peticion, replace: true });
        }}
      />
    </>
  );
}
