/** Clave de ElevenLabs en Ajustes › Motor de vídeo (docs/pantallas.md). Solo se escribe, nunca se lee:
 *  se valida (`POST /settings/validate-elevenlabs-key`, sin coste) y se envía una vez
 *  (`PUT /settings { elevenlabs_api_key }`); el backend la guarda en el almacén de secretos. La UI solo
 *  sabe si está «configurada». El campo se vacía en cuanto se envía, la clave no se guarda en
 *  `localStorage`, ni en el estado persistido, ni en la caché de consultas, y no se pinta de vuelta. */
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useClient } from "../api/context";
import { useSettings } from "../api/queries";
import { sinRutas } from "../video/render/sinRutas";
import { Button, Chip, Field, Input, toast } from "../ui";
import s from "./SettingsScreen.module.css";

/** Quita la clave (y las rutas) de un texto del servidor, por si un error la repitiera. */
const limpio = (texto: string, clave: string) => sinRutas(clave ? texto.split(clave).join("…") : texto);

export function ClaveElevenLabs() {
  const client = useClient();
  const qc = useQueryClient();
  const ajustes = useSettings();
  const configurada = ajustes.data?.has_elevenlabs_key === true;
  const [clave, setClave] = useState("");
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    const enviada = clave.trim();
    if (!enviada || trabajando) return;
    setClave(""); // se envía una vez y no se vuelve a mostrar, ni mientras se valida
    setError(null);
    setTrabajando(true);
    try {
      const v = await client.validateElevenlabsKey(enviada);
      if (!v.valida) {
        setError(limpio(v.detalle ?? "ElevenLabs no reconoce esta clave.", enviada));
        return;
      }
      qc.setQueryData(["settings"], await client.putSettings({ elevenlabs_api_key: enviada }));
      toast({ title: "Clave de ElevenLabs guardada" });
    } catch (err) {
      setError(limpio(err instanceof Error ? err.message : String(err), enviada));
    } finally {
      setTrabajando(false);
    }
  };

  const borrar = async () => {
    setError(null);
    setTrabajando(true);
    try {
      qc.setQueryData(["settings"], await client.putSettings({ elevenlabs_api_key: "" }));
      toast({ title: "Clave de ElevenLabs borrada" });
    } catch (err) {
      setError(limpio(err instanceof Error ? err.message : String(err), ""));
    } finally {
      setTrabajando(false);
    }
  };

  return (
    <div className={s.subseccion}>
      <div className={s.cabecera}>
        <div className={s.flex}>
          <h3 className={s.h3} id="s-eleven">
            Clave de ElevenLabs
          </h3>
          <p className={s.ayuda}>Pone la voz de tus vídeos. Se guarda en este equipo y nunca se vuelve a mostrar.</p>
        </div>
        {ajustes.data && (
          <span data-testid="ajustes-eleven-estado">
            <Chip tone={configurada ? "success" : "read"}>{configurada ? "Configurada" : "No configurada"}</Chip>
          </span>
        )}
      </div>
      <form className={s.altaClave} onSubmit={(e) => void guardar(e)} aria-labelledby="s-eleven">
        <Field label={configurada ? "Nueva clave" : "Clave de la API"} className={s.flex}>
          <Input type="password" mono data-testid="ajustes-eleven-clave" value={clave} onChange={(e) => setClave(e.target.value)} autoComplete="new-password" name="elevenlabs-api-key" data-1p-ignore data-lpignore="true" />
        </Field>
        <Button type="submit" variant="primary" data-testid="ajustes-eleven-guardar" disabled={!clave.trim() || trabajando}>
          Guardar clave
        </Button>
        {configurada && (
          <Button variant="danger" data-testid="ajustes-eleven-borrar" disabled={trabajando} onClick={() => void borrar()}>
            Borrar
          </Button>
        )}
      </form>
      {error && (
        <p className={s.error} role="alert" data-testid="ajustes-eleven-error">
          {error}
        </p>
      )}
    </div>
  );
}
