/** Catálogo de componentes (/#/catalogo, solo en desarrollo): todos los componentes de src/ui y
 *  sus estados, en oscuro y claro a la vez. Sustituye a Storybook y lo usa DS-12 para las capturas. */
import { Bell, Inbox, Play, Search, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { Button, Card, Chip, EmptyState, Field, IconButton, Input, Kbd, Mono, Progress, SegmentedControl, Select, Spinner, TagInput, Textarea } from "../ui";
import s from "./CatalogoScreen.module.css";

type Visibilidad = "private" | "unlisted" | "public";

function Muestra({ tema }: { tema: "dark" | "light" }) {
  const [titulo, setTitulo] = useState("Cómo posicionar un canal de YouTube en 2026");
  const [visibilidad, setVisibilidad] = useState<Visibilidad>("private");
  const [etiquetas, setEtiquetas] = useState(["seo", "youtube"]);

  return (
    <section data-theme={tema} className={s.panel} data-testid={`catalogo-${tema === "dark" ? "oscuro" : "claro"}`}>
      <h2 className={s.titulo}>{tema === "dark" ? "Oscuro" : "Claro"}</h2>

      <h3 className={s.grupo}>Button</h3>
      <div className={s.fila}>
        <Button variant="primary">Primario</Button>
        <Button variant="secondary">Secundario</Button>
        <Button variant="ghost">Fantasma</Button>
        <Button variant="danger" icon={Trash2}>
          Borrar
        </Button>
        <Button variant="primary" loading>
          Subiendo
        </Button>
        <Button disabled>Deshabilitado</Button>
      </div>
      <div className={s.fila}>
        <Button size="sm">sm 32</Button>
        <Button size="md">md 36</Button>
        <Button size="lg" variant="primary" icon={Upload}>
          lg 44
        </Button>
        <IconButton icon={Bell} aria-label="Notificaciones" />
        <IconButton icon={Search} aria-label="Buscar" variant="secondary" />
        <IconButton icon={Play} aria-label="Reproducir" variant="primary" />
      </div>

      <h3 className={s.grupo}>Field, Input, Textarea, Select, TagInput</h3>
      <div className={s.formulario}>
        <Field label="Título" count={titulo.length} max={100} help="Máximo 100 caracteres">
          <Input value={titulo} onChange={(e) => setTitulo(e.target.value)} />
        </Field>
        <Field label="Título con error" error="Falta el título" count={0} max={100}>
          <Input value="" onChange={() => {}} placeholder="Escribe un título" />
        </Field>
        <Field label="Descripción" count={12} max={5000}>
          <Textarea defaultValue="Hola a todos" />
        </Field>
        <Field label="Idioma">
          <Select defaultValue="es">
            <option value="es">Español</option>
            <option value="en">Inglés</option>
          </Select>
        </Field>
        <Field label="Etiquetas" count={etiquetas.join(",").length} max={500}>
          <TagInput value={etiquetas} onChange={setEtiquetas} />
        </Field>
      </div>

      <h3 className={s.grupo}>SegmentedControl</h3>
      <div className={s.fila}>
        <SegmentedControl
          aria-label="Visibilidad"
          value={visibilidad}
          onChange={setVisibilidad}
          options={[
            { value: "private", label: "Privado" },
            { value: "unlisted", label: "Oculto" },
            { value: "public", label: "Público" },
          ]}
        />
      </div>

      <h3 className={s.grupo}>Chip</h3>
      <div className={s.fila}>
        <Chip tone="read">lectura</Chip>
        <Chip tone="write">escritura</Chip>
        <Chip tone="destructive">destructiva</Chip>
        <Chip tone="success">Autorizado</Chip>
        <Chip tone="info">YouTube</Chip>
      </div>

      <h3 className={s.grupo}>Card, Progress, Spinner, Kbd, Mono</h3>
      <div className={s.fila}>
        <Card className={s.tarjeta}>
          <strong>Tarjeta</strong>
          <p>Contenido con borde y superficie.</p>
          <Progress label="Subiendo demo cs finance.mp4" value={0.42} detail="48 MB de 114 MB · quedan ~40 s" />
        </Card>
        <Card raised className={s.tarjeta}>
          <strong>Elevada</strong>
          <p>
            ID <Mono>7uIc5VVIsRE</Mono> · <Kbd>Ctrl</Kbd> + <Kbd>K</Kbd>
          </p>
          <Progress label="Indeterminada" />
        </Card>
        <Spinner />
      </div>

      <h3 className={s.grupo}>EmptyState</h3>
      <EmptyState icon={Inbox} title="Sin resultados" description="Prueba con otras palabras o amplía el filtro." action={<Button>Limpiar filtro</Button>} />
    </section>
  );
}

export function CatalogoScreen() {
  return (
    <div className={s.pagina} data-testid="catalogo">
      <h1>Catálogo de componentes</h1>
      <div className={s.paneles}>
        <Muestra tema="dark" />
        <Muestra tema="light" />
      </div>
    </div>
  );
}
