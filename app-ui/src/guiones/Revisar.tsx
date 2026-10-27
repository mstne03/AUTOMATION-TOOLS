/** Guiones → Revisar: un guion pegado → veredicto del gancho, problemas y gancho reescrito. */
import { RotateCcw, Sparkles } from "lucide-react";
import { useCallback } from "react";
import { useSettings } from "../api/queries";
import { useChat } from "../chat/useChat";
import { CONVERSACION, empezarDeNuevo, parcharRevisar, recibirRespuesta, useGuiones } from "../state/guiones";
import { Button, Field, Textarea } from "../ui";
import { Ayuda, AvisoJson, Fuentes, SelectorFormato, Turnos, useAlTerminarTurno } from "./comunes";
import s from "./Guiones.module.css";
import { LIMITE_GUION, promptRevisar } from "./modelo";

export function Revisar() {
  const chat = useChat(CONVERSACION.revisar);
  const perfil = useSettings().data?.profile;
  const r = useGuiones((st) => st.revisar);
  const { revision } = r;

  useAlTerminarTurno(chat, r.esperando, useCallback((texto: string | null) => recibirRespuesta("revisar", texto), []));

  const motivo = !r.texto.trim()
    ? "Pega el guion que quieres revisar."
    : r.texto.length > LIMITE_GUION
      ? `El guion pasa de ${LIMITE_GUION.toLocaleString("es-ES")} caracteres: recórtalo o revísalo por partes.`
      : chat.enStream
        ? "Espera a que el agente termine."
        : null;

  const revisar = () => {
    parcharRevisar({ esperando: true, jsonError: false });
    void chat.enviar(promptRevisar({ guion: r.texto, formato: r.formato }), { perfil });
  };

  return (
    <div className={s.cuerpo}>
      <div className={s.principal}>
        <section className={s.tarjeta} aria-label="Guion a revisar">
          <Field label="Tu guion" count={r.texto.length} max={LIMITE_GUION}>
            <Textarea data-testid="revisar-guion" rows={12} placeholder="Pega aquí tu guion" value={r.texto} onChange={(ev) => parcharRevisar({ texto: ev.target.value })} />
          </Field>
          <div className={s.fila}>
            <SelectorFormato testid="revisar-formato" valor={r.formato} onChange={(formato) => parcharRevisar({ formato })} />
          </div>
          <div className={s.acciones}>
            <Button variant="primary" icon={Sparkles} data-testid="revisar-enviar" disabled={motivo !== null} onClick={revisar}>
              {chat.enStream ? "Revisando…" : "Revisar guion"}
            </Button>
            {motivo && (
              <p className={s.motivo} data-testid="revisar-motivo">
                {motivo}
              </p>
            )}
          </div>
        </section>

        <AvisoJson visible={r.jsonError} />

        {revision && (
          <section className={s.tarjeta} data-testid="revisar-resultado" aria-labelledby="revisar-gancho-titulo">
            <div className={s.tarjetaCabecera}>
              <h2 id="revisar-gancho-titulo" className={s.h2}>
                Gancho
              </h2>
              <Button size="sm" variant="ghost" icon={RotateCcw} disabled={chat.enStream} onClick={() => empezarDeNuevo("revisar")}>
                Empezar de nuevo
              </Button>
            </div>
            <p className={s.nota} data-testid="revisar-veredicto">
              {revision.veredicto_gancho}
            </p>
            <Field label="Gancho reescrito">
              <Textarea data-testid="revisar-gancho" rows={3} value={revision.gancho_reescrito} onChange={(ev) => parcharRevisar({ revision: { ...revision, gancho_reescrito: ev.target.value } })} />
            </Field>
            <h2 className={s.h2}>Problemas</h2>
            <div className={s.tablaCaja}>
              <table className={s.tabla} data-testid="revisar-problemas">
                <thead>
                  <tr>
                    <th scope="col">Fragmento</th>
                    <th scope="col">Problema</th>
                    <th scope="col">Propuesta</th>
                  </tr>
                </thead>
                <tbody>
                  {revision.problemas.length === 0 ? (
                    <tr data-testid="problema">
                      <td colSpan={3}>No se han encontrado problemas.</td>
                    </tr>
                  ) : (
                    revision.problemas.map((p, i) => (
                      <tr key={i} data-testid="problema">
                        <td>{p.fragmento}</td>
                        <td>{p.problema}</td>
                        <td>{p.propuesta}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <Turnos chat={chat} testid="revisar-turnos" />
      </div>

      <aside className={s.lateral} aria-label="Detalles de la revisión">
        <Ayuda titulo="Qué se revisa">
          <p>Sobre todo el gancho: si llega a la promesa en los primeros segundos y si encaja con el título.</p>
          <p>También el ritmo y los fragmentos donde es probable que se vaya la gente, con una propuesta para cada uno.</p>
        </Ayuda>
        {revision && <Fuentes fuentes={revision.fuentes} />}
      </aside>
    </div>
  );
}
