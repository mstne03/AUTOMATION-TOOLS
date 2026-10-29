/** Guiones → Escribir: tema, formato, duración y público → ganchos, bloques y CTA editables. */
import { Copy, RotateCcw, Sparkles } from "lucide-react";
import { useCallback } from "react";
import { useSettings } from "../api/queries";
import { useChat } from "../chat/useChat";
import { CONVERSACION, cambiarFormatoEscribir, empezarDeNuevo, parcharEscribir, recibirRespuesta, useGuiones } from "../state/guiones";
import { Button, Chip, Field, Input, Textarea, toast } from "../ui";
import { cx } from "../ui/cx";
import { Ayuda, AvisoJson, Fuentes, SelectorFormato, Turnos, useAlTerminarTurno } from "./comunes";
import s from "./Guiones.module.css";
import { duracionTotal, guionMarkdown, mmss, promptEscribir, type BloqueGuion } from "./modelo";

export function Escribir() {
  const chat = useChat(CONVERSACION.escribir);
  const perfil = useSettings().data?.profile;
  const e = useGuiones((st) => st.escribir);
  const { guion } = e;

  useAlTerminarTurno(chat, e.esperando, useCallback((texto: string | null) => recibirRespuesta("escribir", texto), []));

  const motivo = !e.tema.trim() ? "Falta el tema." : !(e.minutos > 0) ? "La duración debe ser mayor que cero." : chat.enStream ? "Espera a que el agente termine." : null;

  const generar = () => {
    parcharEscribir({ esperando: true, jsonError: false });
    void chat.enviar(promptEscribir({ tema: e.tema, formato: e.formato, minutos: e.minutos, publico: e.publico }), { perfil });
  };

  const editarGancho = (i: number, texto: string) => guion && parcharEscribir({ guion: { ...guion, ganchos: guion.ganchos.map((g, j) => (j === i ? { ...g, texto } : g)) } });
  const editarBloque = (i: number, patch: Partial<BloqueGuion>) => guion && parcharEscribir({ guion: { ...guion, bloques: guion.bloques.map((b, j) => (j === i ? { ...b, ...patch } : b)) } });

  const copiar = async () => {
    if (!guion) return;
    try {
      await navigator.clipboard.writeText(guionMarkdown(guion, e.gancho));
      toast({ title: "Guion copiado", description: "En Markdown, con el gancho elegido." });
    } catch (err) {
      toast({ title: "No se pudo copiar el guion", description: (err as Error).message, tone: "error" });
    }
  };

  const objetivo = e.minutos * 60;
  const total = guion ? duracionTotal(guion) : 0;
  const tePasas = total > objetivo * 1.1;

  return (
    <div className={s.cuerpo}>
      <div className={s.principal}>
        <form
          className={s.tarjeta}
          data-testid="escribir-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (!motivo) generar();
          }}
        >
          <Field label="Tema">
            <Input data-testid="escribir-tema" placeholder="¿De qué va el vídeo?" value={e.tema} onChange={(ev) => parcharEscribir({ tema: ev.target.value })} />
          </Field>
          <div className={s.fila}>
            <SelectorFormato testid="escribir-formato" valor={e.formato} onChange={cambiarFormatoEscribir} />
            <Field label="Duración (min)" className={s.estrecho}>
              <Input type="number" data-testid="escribir-duracion" min={0.25} step={0.25} value={e.minutos} onChange={(ev) => parcharEscribir({ minutos: Number(ev.target.value), minutosTocados: true })} />
            </Field>
          </div>
          <Field label="Público">
            <Input data-testid="escribir-publico" placeholder="Opcional: a quién va dirigido" value={e.publico} onChange={(ev) => parcharEscribir({ publico: ev.target.value })} />
          </Field>
          <div className={s.acciones}>
            <Button type="submit" variant="primary" icon={Sparkles} data-testid="escribir-generar" disabled={motivo !== null}>
              {chat.enStream ? "Generando…" : guion ? "Generar otro" : "Generar guion"}
            </Button>
            {motivo && (
              <p className={s.motivo} data-testid="escribir-motivo">
                {motivo}
              </p>
            )}
          </div>
        </form>

        <AvisoJson visible={e.jsonError} />

        {guion && (
          <section className={s.tarjeta} data-testid="escribir-resultado" aria-labelledby="escribir-gancho-titulo">
            <div className={s.tarjetaCabecera}>
              <h2 id="escribir-gancho-titulo" className={s.h2}>
                Gancho
              </h2>
              <Button size="sm" variant="ghost" icon={RotateCcw} disabled={chat.enStream} onClick={() => empezarDeNuevo("escribir")}>
                Empezar de nuevo
              </Button>
            </div>
            <div className={s.ganchos} role="radiogroup" aria-label="Gancho" data-testid="escribir-ganchos">
              {guion.ganchos.map((g, i) => (
                <div key={i} className={cx(s.gancho, e.gancho === i && s.ganchoElegido)} data-testid="gancho-opcion">
                  <input type="radio" name="gancho" aria-label={`Gancho ${i + 1}`} checked={e.gancho === i} onChange={() => parcharEscribir({ gancho: i })} />
                  <span className={s.ganchoCabecera}>
                    <Chip tone="info" data-testid="gancho-tipo">
                      {g.tipo || "gancho"}
                    </Chip>
                  </span>
                  <Textarea className={s.ganchoTexto} rows={2} aria-label={`Texto del gancho ${i + 1}`} value={g.texto} onChange={(ev) => editarGancho(i, ev.target.value)} />
                </div>
              ))}
            </div>

            <h2 className={s.h2}>Bloques</h2>
            <ol className={s.bloques} data-testid="escribir-bloques">
              {guion.bloques.map((b, i) => (
                <li key={i} className={s.bloque} data-testid="bloque-guion">
                  <div className={s.fila}>
                    <Field label="Título" className={s.crece}>
                      <Input data-testid="bloque-titulo" value={b.titulo} onChange={(ev) => editarBloque(i, { titulo: ev.target.value })} />
                    </Field>
                    <Field label="Segundos" className={s.estrecho}>
                      <Input type="number" data-testid="bloque-segundos" min={0} value={b.segundos} onChange={(ev) => editarBloque(i, { segundos: Number(ev.target.value) || 0 })} />
                    </Field>
                  </div>
                  <Field label="Qué se dice">
                    <Textarea data-testid="bloque-contenido" rows={4} value={b.contenido} onChange={(ev) => editarBloque(i, { contenido: ev.target.value })} />
                  </Field>
                  <Field label="Nota visual">
                    <Input data-testid="bloque-visual" value={b.nota_visual} onChange={(ev) => editarBloque(i, { nota_visual: ev.target.value })} />
                  </Field>
                </li>
              ))}
            </ol>

            <Field label="Llamada a la acción">
              <Textarea data-testid="escribir-cta" rows={2} value={guion.cta} onChange={(ev) => parcharEscribir({ guion: { ...guion, cta: ev.target.value } })} />
            </Field>
          </section>
        )}

        <Turnos chat={chat} testid="escribir-turnos" />
      </div>

      <aside className={s.lateral} aria-label="Detalles del guion">
        {guion ? (
          <section className={s.panel} aria-labelledby="escribir-duracion-titulo">
            <span id="escribir-duracion-titulo" className={s.panelTitulo}>
              Duración
            </span>
            <p className={s.metricaIntro} data-testid="escribir-duracion-total" data-nivel={tePasas ? "aviso" : "ok"}>
              <span className={s.metricaValor}>{mmss(total)}</span> <span>de {mmss(objetivo)} objetivo</span>
              {tePasas && (
                <>
                  {" "}
                  <Chip tone="write">Te pasas</Chip>
                </>
              )}
            </p>
            <Button icon={Copy} data-testid="escribir-copiar" onClick={() => void copiar()}>
              Copiar guion
            </Button>
          </section>
        ) : (
          <Ayuda titulo="Cómo funciona">
            <p>El agente consulta la base de conocimiento sobre ganchos, estructura y retención, y lo que hayas guardado en tu KB privada sobre qué funciona en tu canal.</p>
            <p>Te propone varios ganchos para elegir y un guion por bloques que puedes editar antes de copiarlo.</p>
          </Ayuda>
        )}
        {guion && <Fuentes fuentes={guion.fuentes} />}
      </aside>
    </div>
  );
}
