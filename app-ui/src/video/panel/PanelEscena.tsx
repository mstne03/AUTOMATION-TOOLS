/** Pestaña «Escena»: tipo y campos de la escena base (los de `esquema.ts`), el texto de sus frases y
 *  su capa. Cambiar de tipo sustituye solo `base`: las frases viven aparte y se conservan. */
import { editar, useEditor } from "../../state/editor";
import { Button, Field, Input, Select, Textarea } from "../../ui";
import type { EscenaBase, EscenaProyecto, TipoEscena } from "../modelo";
import s from "./Panel.module.css";

const TIPOS: { value: TipoEscena; label: string }[] = [
  { value: "cifra", label: "Cifra" },
  { value: "barras", label: "Barras" },
  { value: "mapa", label: "Mapa" },
  { value: "cartel", label: "Cartel" },
  { value: "titulo3d", label: "Título 3D" },
];
const REGIONES = [
  { value: "espana", label: "España" },
  { value: "europa", label: "Europa" },
  { value: "mundo", label: "Mundo" },
];
/** Salida de una capa nueva: toda la escena. El motor la recorta a lo que dura (`composicion.ts`) y el
 *  timeline también; la duración real no se conoce hasta tener la voz. Es `LIMITES.duracionS`. */
const SALIDA_TODA_LA_ESCENA = 180;
/** Mismas escenas que admiten una capa «detrás» en el motor (`ESCENAS_SOBRE_FONDO`). */
const SOBRE_FONDO: readonly string[] = ["mapa", "barras", "cifra", "cartel"];

type Campo = { campo: string; etiqueta: string; tipo: "texto" | "numero" | "region" | "lista"; opcional?: boolean; max?: number };
const CAMPOS: Record<TipoEscena, Campo[]> = {
  cifra: [
    { campo: "valor", etiqueta: "Valor", tipo: "numero" },
    { campo: "prefijo", etiqueta: "Prefijo", tipo: "texto", max: 12 },
    { campo: "sufijo", etiqueta: "Sufijo", tipo: "texto", max: 12 },
    { campo: "etiqueta", etiqueta: "Etiqueta", tipo: "texto", opcional: true, max: 48 },
    { campo: "decimales", etiqueta: "Decimales (0 a 3)", tipo: "numero" },
  ],
  barras: [
    { campo: "titulo", etiqueta: "Título", tipo: "texto", max: 48 },
    { campo: "prefijo", etiqueta: "Prefijo", tipo: "texto", max: 12 },
    { campo: "sufijo", etiqueta: "Sufijo", tipo: "texto", max: 12 },
    { campo: "fuente", etiqueta: "Fuente", tipo: "texto", opcional: true, max: 60 },
  ],
  mapa: [
    { campo: "region", etiqueta: "Región", tipo: "region" },
    { campo: "destacar", etiqueta: "Zonas destacadas (separadas por comas)", tipo: "lista" },
    { campo: "etiqueta", etiqueta: "Etiqueta", tipo: "texto", opcional: true, max: 40 },
    { campo: "titulo", etiqueta: "Título", tipo: "texto", opcional: true, max: 40 },
  ],
  cartel: [
    { campo: "texto", etiqueta: "Texto", tipo: "texto", max: 40 },
    { campo: "subtexto", etiqueta: "Subtexto", tipo: "texto", opcional: true, max: 60 },
  ],
  titulo3d: [{ campo: "texto", etiqueta: "Texto (ASCII, 12 como máximo)", tipo: "texto", max: 12 }],
};

const textoDe = (b: EscenaBase): string => {
  const r = b as Record<string, unknown>;
  for (const k of ["texto", "titulo"]) if (typeof r[k] === "string" && r[k]) return r[k] as string;
  return "";
};

/** Escena base válida del tipo pedido; reaprovecha el texto de la anterior. */
function baseNueva(tipo: TipoEscena, previa: EscenaBase): EscenaBase {
  const t = textoDe(previa);
  switch (tipo) {
    case "cifra":
      return { tipo, valor: 0, prefijo: "", sufijo: "", decimales: 0 };
    case "barras":
      return {
        tipo,
        titulo: t.slice(0, 48) || "Título",
        periodos: ["A", "B"],
        series: [
          { nombre: "Serie 1", valores: [0, 0] },
          { nombre: "Serie 2", valores: [0, 0] },
        ],
        prefijo: "",
        sufijo: "",
      };
    case "mapa":
      return { tipo, region: "espana", destacar: [] };
    case "cartel":
      return { tipo, texto: t.slice(0, 40) || "Título" };
    case "titulo3d":
      return { tipo, texto: t.replace(/[^ -~]/g, "").toUpperCase().slice(0, 12) || "TITULO" };
  }
}

const esTipo = (v: string): v is TipoEscena => TIPOS.some((t) => t.value === v);

function CampoLista({ valor, onCommit }: { valor: string[]; onCommit: (v: string[]) => void }) {
  // Se confirma al salir del campo: reescribir la lista en cada tecla se come las comas.
  const inicial = valor.join(", ");
  return (
    <Input
      key={inicial}
      defaultValue={inicial}
      onBlur={(e) => {
        const v = e.currentTarget.value
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 8);
        if (v.join(", ") !== inicial) onCommit(v);
      }}
    />
  );
}

function CampoEscena({ escena, c }: { escena: EscenaProyecto; c: Campo }) {
  const base = escena.base as Record<string, unknown>;
  const actual = base[c.campo];
  const poner = (v: unknown) =>
    editar((p) => {
      const e = p.escenas.find((x) => x.id === escena.id);
      if (!e) return;
      const b = e.base as Record<string, unknown>;
      if (v === undefined) delete b[c.campo];
      else b[c.campo] = v;
    });
  return (
    <div data-testid={`escena-campo-${c.campo}`}>
      <Field label={c.etiqueta}>
        {c.tipo === "texto" && (
          <Input value={typeof actual === "string" ? actual : ""} maxLength={c.max} onChange={(e) => poner(e.target.value === "" && c.opcional ? undefined : e.target.value)} />
        )}
        {c.tipo === "numero" && (
          <Input
            type="number"
            value={typeof actual === "number" ? String(actual) : ""}
            onChange={(e) => {
              const n = e.target.valueAsNumber;
              if (Number.isFinite(n)) poner(n);
            }}
          />
        )}
        {c.tipo === "region" && (
          <Select value={typeof actual === "string" ? actual : "espana"} onChange={(e) => poner(e.target.value)}>
            {REGIONES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        )}
        {c.tipo === "lista" && <CampoLista valor={Array.isArray(actual) ? actual.filter((x): x is string => typeof x === "string") : []} onCommit={poner} />}
      </Field>
    </div>
  );
}

export function PanelEscena() {
  const seleccion = useEditor((e) => e.seleccion);
  const escena = useEditor((e) => {
    const p = e.proyecto;
    if (!p || !e.seleccion) return undefined;
    return p.escenas.find((x) => x.id === e.seleccion) ?? p.escenas.find((x) => x.fraseIds.includes(e.seleccion!));
  });
  const frases = useEditor((e) => e.proyecto?.frases);
  const recursos = useEditor((e) => e.proyecto?.recursos);

  if (!escena || !seleccion) {
    return (
      <div className={s.seccion} data-testid="panel-escena">
        <p className={s.vacio} data-testid="escena-vacia">
          Selecciona una escena en el timeline para editarla.
        </p>
      </div>
    );
  }

  const id = escena.id;
  const cambiarTipo = (v: string) => {
    if (!esTipo(v) || v === escena.base.tipo) return;
    editar((p) => {
      const e = p.escenas.find((x) => x.id === id);
      if (!e) return;
      e.base = baseNueva(v, e.base);
      if (e.capa?.modo === "detras" && !SOBRE_FONDO.includes(v)) e.capa.modo = "encima";
    });
  };
  const ponerFrase = (fraseId: string, texto: string) =>
    editar((p) => {
      const f = p.frases.find((x) => x.id === fraseId);
      if (f) f.texto = texto;
    });
  const ponerCapa = (cambio: Partial<{ modo: "encima" | "detras"; encuadre: "marco" | "zoom" | "paneo" }>) =>
    editar((p) => {
      const e = p.escenas.find((x) => x.id === id);
      if (e?.capa) Object.assign(e.capa, cambio);
    });
  /** Elegir un recurso crea la capa (o cambia su recurso) y da por cubierto el que pedía el guion. */
  const ponerRecurso = (rid: string) =>
    editar((p) => {
      const e = p.escenas.find((x) => x.id === id);
      if (!e) return;
      if (!rid) {
        delete e.capa;
        return;
      }
      if (!p.recursos.some((r) => r.id === rid && (r.clase === "foto" || r.clase === "clip"))) return;
      if (e.capa) e.capa.recursoId = rid;
      else e.capa = { recursoId: rid, modo: "encima", encuadre: "marco", entrada: 0, salida: SALIDA_TODA_LA_ESCENA };
      delete e.recursoPendiente;
    });
  const visuales = (recursos ?? []).filter((r) => r.clase === "foto" || r.clase === "clip");
  const modos = SOBRE_FONDO.includes(escena.base.tipo) ? (["encima", "detras"] as const) : (["encima"] as const);

  return (
    <div className={s.seccion} data-testid="panel-escena">
      <Field label="Tipo de escena">
        <Select value={escena.base.tipo} onChange={(e) => cambiarTipo(e.target.value)} data-testid="escena-tipo">
          {TIPOS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className={s.campos}>
        {CAMPOS[escena.base.tipo].map((c) => (
          <CampoEscena key={`${escena.base.tipo}-${c.campo}`} escena={escena} c={c} />
        ))}
      </div>
      <h3 className={s.titulo}>Frases</h3>
      <div className={s.campos}>
        {escena.fraseIds.map((fid, i) => {
          const f = frases?.find((x) => x.id === fid);
          if (!f) return null;
          return (
            <div key={fid} data-testid={`escena-frase-${fid}`}>
              <Field label={`Frase ${i + 1}`}>
                <Textarea rows={2} maxLength={400} value={f.texto} onChange={(e) => ponerFrase(fid, e.target.value)} />
              </Field>
            </div>
          );
        })}
      </div>
      <h3 className={s.titulo}>Foto o clip</h3>
      {visuales.length > 0 || escena.capa ? (
        <Field label="Recurso de la escena">
          <Select value={escena.capa?.recursoId ?? ""} onChange={(e) => ponerRecurso(e.target.value)} data-testid="escena-capa-recurso">
            <option value="">Ninguno</option>
            {visuales.map((r) => (
              <option key={r.id} value={r.id}>
                {r.clase === "foto" ? "Foto" : "Clip"}: {r.nombreOriginal}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <p className={s.meta} data-testid="escena-capa-sin-recursos">
          Añade fotos o clips en la pestaña «Recursos» y elígelos aquí.
        </p>
      )}
      {escena.capa && (
        <>
          <div className={s.campos}>
            <Field label="Modo">
              <Select value={escena.capa.modo} onChange={(e) => ponerCapa({ modo: e.target.value === "detras" ? "detras" : "encima" })} data-testid="escena-capa-modo">
                {modos.map((m) => (
                  <option key={m} value={m}>
                    {m === "encima" ? "Encima" : "Detrás"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Encuadre">
              <Select
                value={escena.capa.encuadre}
                onChange={(e) => ponerCapa({ encuadre: e.target.value === "zoom" ? "zoom" : e.target.value === "paneo" ? "paneo" : "marco" })}
                data-testid="escena-capa-encuadre"
              >
                <option value="marco">Marco</option>
                <option value="zoom">Zoom</option>
                <option value="paneo">Paneo</option>
              </Select>
            </Field>
            <div className={s.fila}>
              <Button
                size="sm"
                variant="ghost"
                data-testid="escena-capa-quitar"
                onClick={() =>
                  editar((p) => {
                    const e = p.escenas.find((x) => x.id === id);
                    if (e) delete e.capa;
                  })
                }
              >
                Quitar la capa
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
