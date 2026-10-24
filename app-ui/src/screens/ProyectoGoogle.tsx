/** Proyecto de Google Cloud de la app (SEO-101/SEO-96): un solo client_secret.json para todos los
 *  canales, un token por canal. Lo comparten Onboarding (paso Google Cloud) y Ajustes (Sustituir…). */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileCheck, FileJson } from "lucide-react";
import { useState, type DragEvent } from "react";
import { ApiError } from "../api/client";
import { useClient } from "../api/context";
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

/** Zona para soltar, selector, JSON pegado o ruta, e "Importar". Si el fichero es de otro proyecto y
 *  hay canales autorizados, el sidecar responde 409 y se pide confirmación antes de sustituirlo. */
export function ImportarClientSecret({ onImportado }: { onImportado?: (r: SettingsTrasProyecto) => void }) {
  const client = useClient();
  const qc = useQueryClient();
  const [jsonText, setJsonText] = useState("");
  const [path, setPath] = useState("");
  /** Nombre del fichero elegido o soltado; se olvida si el usuario edita el JSON o la ruta a mano. */
  const [fichero, setFichero] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [arrastrando, setArrastrando] = useState(false);
  const [conflicto, setConflicto] = useState<{ cuerpo: Cuerpo; detalle: string } | null>(null);

  const importar = useMutation({
    mutationFn: (body: Cuerpo & { replace?: boolean }) => client.importClientSecret(body),
    onSuccess: (r) => {
      qc.setQueryData(["settings"], r);
      void qc.invalidateQueries({ queryKey: ["youtube"] });
      setJsonText("");
      setPath("");
      setFichero(null);
      setError(null);
      toast(
        r.desautorizados.length
          ? { title: "Proyecto de Google sustituido", description: `Vuelve a autorizar: ${r.desautorizados.join(", ")}.`, tone: "warning" }
          : { title: "Credenciales de Google importadas" },
      );
      onImportado?.(r);
    },
    onError: (e, body) => {
      if (e instanceof ApiError && e.status === 409 && !body.replace) setConflicto({ cuerpo: body, detalle: e.detail });
      else setError(e.message);
    },
  });

  const onImportar = () => {
    if (jsonText.trim()) {
      const err = validarClientSecret(jsonText);
      if (err) return setError(err);
      return importar.mutate({ json_text: jsonText });
    }
    if (path.trim()) return importar.mutate({ path: path.trim() });
    setError("Pega el JSON, suéltalo aquí o indica la ruta del fichero.");
  };

  const leerFichero = async (f: File) => {
    const texto = await f.text();
    setJsonText(texto);
    setPath("");
    setFichero(f.name);
    setError(validarClientSecret(texto));
  };
  const soltar = (e: DragEvent) => {
    e.preventDefault();
    setArrastrando(false);
    const f = e.dataTransfer.files[0];
    if (f) void leerFichero(f);
  };
  const elegirFichero = async () => {
    try {
      const ruta = await elegirClientSecret();
      if (ruta) {
        setJsonText("");
        setPath(ruta);
        setFichero(ruta.split(/[\\/]/).pop() ?? ruta);
        setError(null);
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  return (
    <>
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
        {fichero ? (
          <>
            <FileCheck aria-hidden size="1.6em" className={s.ok} />
            <span data-testid="google-elegido" role="status">
              <Mono>{fichero}</Mono> listo para importar
            </span>
          </>
        ) : (
          <>
            <FileJson aria-hidden size="1.6em" />
            <span>
              Suelta aquí el <Mono>client_secret.json</Mono> descargado
            </span>
            <span className={s.suave}>o</span>
          </>
        )}
        {/* Un solo selector: en la app, el explorador nativo (Rust); fuera de Tauri (E2E, pnpm dev),
            el del navegador. Los dos a la vez se contradecían al usar uno de ellos. */}
        {enTauri() ? (
          <Button size="sm" data-testid="google-elegir" onClick={() => void elegirFichero()}>
            {fichero ? "Elegir otro…" : "Elegir fichero…"}
          </Button>
        ) : (
          <input type="file" accept=".json,application/json" aria-label="Elegir el client_secret.json" data-testid="google-fichero" onChange={(e) => e.target.files?.[0] && void leerFichero(e.target.files[0])} />
        )}
      </div>

      <Field label="O pega aquí el contenido del JSON">
        <Textarea
          data-testid="google-json"
          rows={4}
          placeholder='{"installed": {"client_id": …}}'
          value={jsonText}
          onChange={(e) => {
            setJsonText(e.target.value);
            setFichero(null);
          }}
        />
      </Field>
      <div className={s.fila}>
        <Field label="O la ruta del fichero" className={s.crece}>
          <Input
            mono
            data-testid="google-path"
            placeholder="C:\Users\…\client_secret_….json"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setFichero(null);
            }}
          />
        </Field>
        <Button variant="primary" data-testid="google-importar" loading={importar.isPending} onClick={onImportar}>
          Importar
        </Button>
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
          if (conflicto) importar.mutate({ ...conflicto.cuerpo, replace: true });
        }}
      />
    </>
  );
}
