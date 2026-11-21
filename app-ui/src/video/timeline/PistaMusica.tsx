/** Pista 4: música aportada por el usuario (sin catálogo en v1): pista de `GET /video/musica`,
 *  inicio, volumen y ducking. Cada cambio es una edición del store, con deshacer. */
import { useQuery } from "@tanstack/react-query";
import { editar, useEditor } from "../../state/editor";
import { useClient } from "../../api/context";
import { Input, Select } from "../../ui";
import { cx } from "../../ui/cx";
import { tiempoAX, type Disposicion } from "./geometria";
import s from "./Timeline.module.css";

const VOLUMEN_POR_DEFECTO = 0.25;

export function useMusica() {
  const client = useClient();
  return useQuery({ queryKey: ["video", "musica"], queryFn: () => client.videoMusica(), retry: false });
}

const acotar = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function cambiar(campo: "inicio" | "volumen" | "ducking", valor: number | boolean) {
  editar((p) => {
    if (p.musica) (p.musica as Record<string, number | boolean | string>)[campo] = valor;
  });
}

/** Controles de la pista: van en la columna fija de etiquetas. */
export function ControlesMusica({ total }: { total: number }) {
  const musica = useEditor((e) => e.proyecto?.musica);
  const pistas = useMusica();
  const lista = pistas.data ?? [];
  const conocida = !musica || lista.some((x) => x.id === musica.pistaId);

  const elegir = (id: string) => {
    editar((p) => {
      if (!id) delete p.musica;
      else p.musica = { pistaId: id, inicio: p.musica?.inicio ?? 0, volumen: p.musica?.volumen ?? VOLUMEN_POR_DEFECTO, ducking: p.musica?.ducking ?? true };
    });
  };

  return (
    <div className={s.controles}>
      <Select compact aria-label="Pista de música" data-testid="musica-elegir" value={musica?.pistaId ?? ""} onChange={(e) => elegir(e.target.value)}>
        <option value="">Sin música</option>
        {!conocida && musica && <option value={musica.pistaId}>{musica.pistaId}</option>}
        {lista.map((x) => (
          <option key={x.id} value={x.id}>
            {x.nombre ?? x.id}
          </option>
        ))}
      </Select>
      {musica && (
        <>
          <label className={s.campo}>
            <span>Inicio (s)</span>
            <Input
              type="number"
              min={0}
              max={Math.max(0, Math.floor(total))}
              step={0.1}
              data-testid="musica-inicio"
              value={musica.inicio}
              onChange={(e) => {
                const n = e.target.valueAsNumber;
                if (Number.isFinite(n)) cambiar("inicio", acotar(n, 0, Math.max(0, total)));
              }}
            />
          </label>
          <label className={s.campo}>
            <span>Volumen</span>
            <Input
              type="range"
              min={0}
              max={1}
              step={0.05}
              data-testid="musica-volumen"
              value={musica.volumen}
              onChange={(e) => {
                const n = e.target.valueAsNumber;
                if (Number.isFinite(n)) cambiar("volumen", acotar(n, 0, 1));
              }}
            />
          </label>
          <label className={s.campoCheck}>
            <input type="checkbox" data-testid="musica-ducking" checked={musica.ducking} onChange={(e) => cambiar("ducking", e.target.checked)} />
            <span>Bajar bajo la voz</span>
          </label>
        </>
      )}
    </div>
  );
}

export function PistaMusica({ layout }: { layout: Disposicion }) {
  const musica = useEditor((e) => e.proyecto?.musica);
  const pistas = useMusica();
  const nombre = musica ? (pistas.data?.find((x) => x.id === musica.pistaId)?.nombre ?? musica.pistaId) : "";
  const inicio = musica ? Math.min(musica.inicio, layout.total) : 0;
  return (
    <div className={s.pista} data-testid="pista-musica">
      {musica && (
        <div
          className={cx(s.clip, s.clipMusica)}
          style={{ left: tiempoAX(inicio), width: Math.max(tiempoAX(layout.total - inicio), 12), opacity: 0.4 + 0.6 * musica.volumen }}
          title={nombre}
        >
          <span className={s.texto}>{nombre}</span>
        </div>
      )}
    </div>
  );
}
