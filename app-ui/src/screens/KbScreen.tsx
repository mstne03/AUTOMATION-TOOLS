/** Base de conocimiento (docs/pantallas.md → KB). El sidecar devuelve texto ya formateado. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useClient } from "../api/context";

const PLATAFORMAS = ["", "youtube", "tiktok", "instagram", "linkedin", "x"];

export function KbScreen() {
  const client = useClient();
  const estado = useQuery({ queryKey: ["kb", "estado"], queryFn: () => client.kbEstado() });
  const [q, setQ] = useState("");
  const [plataforma, setPlataforma] = useState("");
  const buscar = useMutation({ mutationFn: () => client.kbBuscar(q, plataforma || undefined, 5) });
  const fuentes = useMutation({ mutationFn: () => client.kbFuentes(plataforma || undefined) });

  const onBuscar = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) buscar.mutate();
  };

  return (
    <div className="kb">
      <h1>Base de conocimiento</h1>
      <section>
        <h2>Estado</h2>
        {estado.isPending && <p>Cargando…</p>}
        {estado.isError && <p className="error">{estado.error.message}</p>}
        {estado.data && <pre data-testid="kb-estado">{estado.data.texto}</pre>}
      </section>
      <section>
        <h2>Buscar</h2>
        <form className="fila" data-testid="kb-buscar" onSubmit={onBuscar}>
          <input data-testid="kb-q" placeholder="p. ej. mejor hora para publicar shorts" value={q} onChange={(e) => setQ(e.target.value)} />
          <select data-testid="kb-plataforma" value={plataforma} onChange={(e) => setPlataforma(e.target.value)}>
            {PLATAFORMAS.map((p) => (
              <option key={p} value={p}>
                {p || "todas"}
              </option>
            ))}
          </select>
          <button type="submit" data-testid="kb-buscar-btn" disabled={!q.trim() || buscar.isPending}>
            {buscar.isPending ? "Buscando…" : "Buscar"}
          </button>
        </form>
        {buscar.error && <p className="error">{buscar.error.message}</p>}
        {buscar.data && <pre data-testid="kb-resultado">{buscar.data.texto}</pre>}
      </section>
      <section>
        <h2>Fuentes</h2>
        <button data-testid="kb-fuentes" onClick={() => fuentes.mutate()} disabled={fuentes.isPending}>
          {fuentes.isPending ? "Cargando…" : "Ver fuentes"}
        </button>
        {fuentes.error && <p className="error">{fuentes.error.message}</p>}
        {fuentes.data && <pre data-testid="kb-fuentes-texto">{fuentes.data.texto}</pre>}
      </section>
    </div>
  );
}
