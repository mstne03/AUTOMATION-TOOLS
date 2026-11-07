/** Lista de proyectos de vídeo (docs/pantallas.md → Vídeo › Lista). Títulos y perfiles son texto:
 *  nunca HTML. El borrado pide confirmación y lo hace el backend a partir del id (D6b, I10). */
import { Film, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../api/client";
import { useBorrarProyectoVideo, useProyectosVideo } from "../api/queries";
import type { EstadoProyectoVideo, ProyectoVideoResumen } from "../api/types";
import {
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  Estado,
  IconButton,
  Spinner,
  toast,
  type ChipTone,
} from "../ui";
import { sinRutas } from "./MotorVideo";
import s from "./Video.module.css";

const ESTADOS: Record<EstadoProyectoVideo, [string, ChipTone]> = {
  borrador: ["Borrador", "read"],
  renderizando: ["Renderizando…", "info"],
  listo: ["Listo", "success"],
  error: ["Error", "destructive"],
};

export function duracionTexto(seg: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(seg) ? seg : 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
const fecha = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "sin fecha"
    : d.toLocaleDateString("es-ES", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
};
const esSinMotor = (e: unknown) => e instanceof ApiError && e.status === 503;

export function VideoScreen() {
  const proyectos = useProyectosVideo();
  const borrar = useBorrarProyectoVideo();
  const [aBorrar, setABorrar] = useState<ProyectoVideoResumen | null>(null);

  return (
    <section className={s.pantalla}>
      <h1 className={s.h1}>Vídeo</h1>
      {proyectos.isPending ? (
        <Spinner />
      ) : proyectos.isError ? (
        esSinMotor(proyectos.error) ? (
          <Estado data-testid="video-sin-motor">
            El módulo de vídeo no está instalado en esta versión.
          </Estado>
        ) : (
          <div data-testid="video-error" role="alert">
            <Estado as="div" error>
              {sinRutas(proyectos.error.message)}
            </Estado>
          </div>
        )
      ) : proyectos.data.length === 0 ? (
        <div data-testid="video-vacio">
          <EmptyState
            icon={Film}
            title="Aún no hay vídeos"
            description="Escribe un guion en Guiones con el formato Vídeo y pulsa «Crear vídeo»."
            action={
              <Link to="/guiones">
                <Button variant="secondary">Ir a Guiones</Button>
              </Link>
            }
          />
        </div>
      ) : (
        <ul className={s.lista} data-testid="video-lista">
          {proyectos.data.map((p) => {
            const [etiqueta, tono] = ESTADOS[p.estado] ?? ESTADOS.error;
            return (
              <li
                key={p.id}
                className={s.fila}
                data-testid={`video-proyecto-${p.id}`}
              >
                <div className={s.cuerpo}>
                  <Link
                    to={`/video/${encodeURIComponent(p.id)}`}
                    className={s.titulo}
                  >
                    {p.titulo}
                  </Link>
                  <span className={s.meta}>
                    {p.perfil} · {duracionTexto(p.duracion)} ·{" "}
                    {fecha(p.actualizado)}
                  </span>
                </div>
                <Chip
                  tone={tono}
                  data-testid={`video-proyecto-estado-${p.id}`}
                  data-estado={p.estado}
                >
                  {etiqueta}
                </Chip>
                <IconButton
                  icon={Trash2}
                  variant="ghost"
                  aria-label={`Borrar el proyecto ${p.titulo}`}
                  data-testid={`video-proyecto-borrar-${p.id}`}
                  onClick={() => setABorrar(p)}
                />
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={aBorrar !== null}
        onOpenChange={(abierto) => !abierto && setABorrar(null)}
        title="¿Borrar el proyecto?"
        description={
          aBorrar
            ? `«${aBorrar.titulo}» y todos sus recursos se borrarán del disco. No se puede deshacer.`
            : undefined
        }
        confirmLabel="Borrar"
        tone="danger"
        onConfirm={async () => {
          const p = aBorrar;
          if (!p) return;
          try {
            await borrar.mutateAsync(p.id);
          } catch (e) {
            toast({
              title: "No se pudo borrar",
              description: sinRutas(
                e instanceof Error ? e.message : "Error desconocido",
              ),
              tone: "error",
            });
          }
        }}
      />
    </section>
  );
}
