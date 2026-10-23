/** Base de conocimiento (docs/pantallas.md → KB): estado del snapshot, búsqueda con resultados como
 *  tarjetas, fuentes y "Mi base privada". Los datos estructurados vienen de ?formato=json; el texto
 *  de las tools sigue siendo lo que lee el agente. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Trash2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useClient } from "../api/context";
import type { KbFuente, KbResultado } from "../api/types";
import { EnlaceExterno, esUrlHttps } from "../enlaces";
import { Button, Card, Chip, ConfirmDialog, EmptyState, Field, IconButton, Input, Mono, SegmentedControl, Select, toast } from "../ui";
import s from "./KbScreen.module.css";

const PLATAFORMAS = ["", "youtube", "tiktok", "instagram", "linkedin", "x"];
type Origen = "todas" | "publica" | "privada";

const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" }) : "sin fecha");

function dominio(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Título enlazado si la fuente es una URL https (abre con abrir_url); si no, texto y su identificador. */
function Titulo({ titulo, url }: { titulo: string; url: string | null }) {
  if (url && esUrlHttps(url)) {
    return (
      <EnlaceExterno href={url} className={s.titulo}>
        {titulo} ↗
      </EnlaceExterno>
    );
  }
  return <span className={s.titulo}>{titulo}</span>;
}

function Etiquetas({ x }: { x: Pick<KbFuente, "plataforma" | "origen" | "fecha"> }) {
  return (
    <span className={s.etiquetas}>
      {x.plataforma && <Chip tone="info">{x.plataforma}</Chip>}
      <Chip tone={x.origen === "privada" ? "write" : "read"}>{x.origen === "privada" ? "KB privada" : "Pública"}</Chip>
      <span className={s.fecha}>{fecha(x.fecha)}</span>
    </span>
  );
}

export function KbScreen() {
  const client = useClient();
  const qc = useQueryClient();
  const estado = useQuery({ queryKey: ["kb", "estado"], queryFn: () => client.kbEstado() });
  const privada = useQuery({ queryKey: ["kb", "privada"], queryFn: () => client.kbPrivadaFuentes() });
  const [q, setQ] = useState("");
  const [plataforma, setPlataforma] = useState("");
  const [origen, setOrigen] = useState<Origen>("todas");
  const [urlNueva, setUrlNueva] = useState("");
  const [aBorrar, setABorrar] = useState<string | null>(null);
  const campoUrl = useRef<HTMLInputElement>(null);

  const buscar = useMutation({ mutationFn: () => client.kbBuscarJson(q, plataforma || undefined, 8) });
  const fuentes = useMutation({ mutationFn: () => client.kbFuentesJson(plataforma || undefined) });
  const actualizar = useMutation({
    mutationFn: () => client.kbUpdate(),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["kb", "estado"] });
      toast({ title: r.accion === "sin_cambios" ? "Ya tienes la última versión" : "Base de conocimiento actualizada", description: r.version ? `Versión ${r.version}` : undefined });
    },
    onError: (e) => toast({ title: "No se pudo actualizar", description: e.message, tone: "error" }),
  });
  const anadir = useMutation({
    mutationFn: (url: string) => client.kbPrivadaAnadir(url),
    onSuccess: (r) => {
      setUrlNueva("");
      void qc.invalidateQueries({ queryKey: ["kb", "privada"] });
      toast({ title: r.skipped ? "Ya estaba en tu base privada" : "Añadida a tu base privada", description: r.skipped ? undefined : `${r.chunks} fragmentos` });
    },
    onError: (e) => toast({ title: "No se pudo añadir", description: e.message, tone: "error" }),
  });
  const borrar = useMutation({
    mutationFn: (url: string) => client.kbPrivadaBorrar(url),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["kb", "privada"] });
      toast({ title: "Quitada de tu base privada" });
    },
    onError: (e) => toast({ title: "No se pudo borrar", description: e.message, tone: "error" }),
  });

  const onBuscar = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) buscar.mutate();
  };
  const filtrar = <T extends { origen: string }>(xs: T[] | undefined) => (xs ?? []).filter((x) => origen === "todas" || x.origen === origen);
  const resultados = filtrar<KbResultado>(buscar.data);
  const lista = filtrar<KbFuente>(fuentes.data);
  const urlValida = /^https?:\/\/\S+$/.test(urlNueva.trim());
  const snap = estado.data?.snapshot;

  return (
    <div className={s.pantalla}>
      <h1 className={s.h1}>Base de conocimiento</h1>

      <Card as="section" className={s.seccion} aria-labelledby="kb-t-estado" data-testid="kb-snapshot">
        <div className={s.cabecera}>
          <h2 id="kb-t-estado" className={s.h2}>
            Estado
          </h2>
          <Button size="sm" data-testid="kb-actualizar" loading={actualizar.isPending} onClick={() => actualizar.mutate()}>
            Buscar actualización
          </Button>
        </div>
        {estado.isPending && <p className={s.suave}>Cargando…</p>}
        {estado.isError && <p className={s.error}>{estado.error.message}</p>}
        {snap && (
          <dl className={s.datos}>
            <div>
              <dt>Versión</dt>
              <dd>
                <Mono>{snap.version ?? "—"}</Mono>
              </dd>
            </div>
            <div>
              <dt>Instalada</dt>
              <dd>{snap.exportada ? fecha(snap.exportada) : "—"}</dd>
            </div>
            <div>
              <dt>Documentos</dt>
              <dd>{snap.documentos ?? "—"}</dd>
            </div>
            <div>
              <dt>Fragmentos</dt>
              <dd>{snap.chunks ?? "—"}</dd>
            </div>
            <div>
              <dt>Firma</dt>
              <dd>{snap.instalada ? <Chip tone="success">Verificada al instalar</Chip> : <Chip tone="write">No instalada</Chip>}</dd>
            </div>
          </dl>
        )}
        {snap?.ultimo_error && <p className={s.error}>Último error al actualizar: {snap.ultimo_error}</p>}
        {estado.data && (
          <details className={s.detalle}>
            <summary>Ver estado detallado</summary>
            <pre data-testid="kb-estado">{estado.data.texto}</pre>
          </details>
        )}
      </Card>

      <Card as="section" className={s.seccion} aria-labelledby="kb-t-buscar">
        <h2 id="kb-t-buscar" className={s.h2}>
          Buscar
        </h2>
        <form className={s.buscador} data-testid="kb-buscar" onSubmit={onBuscar}>
          <Field label="Pregunta" className={s.crece}>
            <Input data-testid="kb-q" placeholder="p. ej. mejor hora para publicar shorts" value={q} onChange={(e) => setQ(e.target.value)} />
          </Field>
          <Field label="Plataforma">
            <Select data-testid="kb-plataforma" value={plataforma} onChange={(e) => setPlataforma(e.target.value)}>
              {PLATAFORMAS.map((p) => (
                <option key={p} value={p}>
                  {p || "todas"}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="primary" data-testid="kb-buscar-btn" disabled={!q.trim()} loading={buscar.isPending}>
            {buscar.isPending ? "Buscando…" : "Buscar"}
          </Button>
        </form>
        <div className={s.filtro}>
          <span className={s.suave}>Origen</span>
          <SegmentedControl
            aria-label="Origen"
            data-testid="kb-origen"
            value={origen}
            onChange={setOrigen}
            options={[
              { value: "todas", label: "Todos" },
              { value: "publica", label: "Pública" },
              { value: "privada", label: "KB privada" },
            ]}
          />
        </div>
        {buscar.error && <p className={s.error}>{buscar.error.message}</p>}
        {buscar.data && (
          <div data-testid="kb-resultado" className={s.resultados}>
            <p className={s.suave} data-testid="kb-resultado-total">
              {resultados.length} {resultados.length === 1 ? "resultado" : "resultados"}
            </p>
            {resultados.length === 0 && <EmptyState icon={BookOpen} title="Sin resultados" description="Prueba con otras palabras, otra plataforma o cambia el origen." />}
            {resultados.map((r, i) => (
              <article key={`${r.url}-${i}`} className={s.tarjeta} data-testid="kb-tarjeta">
                <div className={s.tarjetaCabecera}>
                  <Titulo titulo={r.titulo} url={r.url} />
                  <Etiquetas x={r} />
                </div>
                <p className={s.fragmento}>{r.fragmento}</p>
                {r.url && <span className={s.fuente}>{esUrlHttps(r.url) ? dominio(r.url) : <Mono>{r.url}</Mono>}</span>}
              </article>
            ))}
          </div>
        )}
      </Card>

      <Card as="section" className={s.seccion} aria-labelledby="kb-t-fuentes">
        <div className={s.cabecera}>
          <h2 id="kb-t-fuentes" className={s.h2}>
            Fuentes
          </h2>
          <Button size="sm" data-testid="kb-fuentes" loading={fuentes.isPending} onClick={() => fuentes.mutate()}>
            {fuentes.isPending ? "Cargando…" : "Ver fuentes"}
          </Button>
        </div>
        {fuentes.error && <p className={s.error}>{fuentes.error.message}</p>}
        {fuentes.data && (
          <div data-testid="kb-fuentes-lista">
            <p className={s.suave}>
              {lista.length} {lista.length === 1 ? "fuente" : "fuentes"}
              {plataforma ? ` de ${plataforma}` : ""}
            </p>
            <ul className={s.fuentes}>
              {lista.map((f, i) => (
                <li key={`${f.url}-${i}`} className={s.fuenteFila} data-testid="kb-fuente">
                  <Titulo titulo={f.titulo} url={f.url} />
                  <Etiquetas x={f} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card as="section" className={s.seccion} aria-labelledby="kb-t-privada" data-testid="kb-privada">
        <div>
          <h2 id="kb-t-privada" className={s.h2}>
            Mi base privada
          </h2>
          <p className={s.ayuda}>Páginas y vídeos que añades tú; el agente los busca junto al snapshot público. Se guardan solo en este equipo.</p>
        </div>
        <form
          className={s.alta}
          onSubmit={(e) => {
            e.preventDefault();
            if (urlValida) anadir.mutate(urlNueva.trim());
          }}
        >
          <Field label="Añadir una URL" className={s.crece} error={urlNueva !== "" && !urlValida ? "Escribe una URL que empiece por http:// o https://" : undefined}>
            <Input ref={campoUrl} data-testid="kb-privada-url" placeholder="https://…" value={urlNueva} onChange={(e) => setUrlNueva(e.target.value)} disabled={anadir.isPending} />
          </Field>
          <Button type="submit" variant="primary" data-testid="kb-privada-add" disabled={!urlValida} loading={anadir.isPending}>
            {anadir.isPending ? "Añadiendo…" : "Añadir"}
          </Button>
        </form>
        {privada.isError && <p className={s.error}>{privada.error.message}</p>}
        {privada.data && privada.data.length === 0 && (
          <EmptyState
            icon={BookOpen}
            title="Tu base privada está vacía"
            description="Añade una URL para que el agente la tenga en cuenta."
            action={<Button onClick={() => campoUrl.current?.focus()}>Añadir URL</Button>}
          />
        )}
        {privada.data && privada.data.length > 0 && (
          <ul className={s.fuentes} data-testid="kb-privada-lista">
            {privada.data.map((f) => (
              <li key={f.url} className={s.fuenteFila} data-testid="kb-privada-item">
                <Titulo titulo={f.title ?? f.url} url={f.url} />
                <Etiquetas x={{ plataforma: f.platforms[0] ?? null, origen: "privada", fecha: f.published_at }} />
                <IconButton icon={Trash2} size="xs" variant="ghost" aria-label={`Quitar ${f.title ?? f.url} de tu base privada`} data-testid="kb-privada-borrar" onClick={() => setABorrar(f.url)} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={aBorrar !== null}
        onOpenChange={(a) => !a && setABorrar(null)}
        title="¿Quitar de tu base privada?"
        description={aBorrar ?? undefined}
        confirmLabel="Quitar"
        tone="danger"
        onConfirm={() => {
          if (aBorrar) borrar.mutate(aBorrar);
        }}
      />
    </div>
  );
}
