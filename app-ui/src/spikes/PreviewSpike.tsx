/** Spike D6 (desechable, solo DEV): preview de una `_composicion/` en un iframe aislado.
 *  El iframe va con `sandbox="allow-scripts"` SIN `allow-same-origin`: origen opaco, sin acceso a
 *  `window.__TAURI__` ni al token. Se controla solo por postMessage (ver CONTROL_JS del backend).
 *  El botón «Medir» ejecuta dentro de la propia app las mismas mediciones que el informe y las
 *  muestra en pantalla (y en `window.__spikeResultados`). */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { sidecarInfo } from "../sidecar";

type Msg = { tipo: string; id?: number; [k: string]: unknown };

const SEEKS = [1, 10, 25, 45];
const REPETICIONES = 3;
const dormir = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const mediana = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const r1 = (n: number) => Math.round(n * 10) / 10;

export function PreviewSpike() {
  const [params] = useSearchParams();
  const escala = Number(params.get("escala") ?? "0.4");
  const [src, setSrc] = useState<string>();
  const [listo, setListo] = useState(false);
  const [estado, setEstado] = useState("");
  const [resultados, setResultados] = useState<Record<string, unknown> | null>(null);
  const ifr = useRef<HTMLIFrameElement>(null);
  const pendientes = useRef(new Map<number, (m: Msg) => void>());
  const contador = useRef(0);

  useEffect(() => {
    sidecarInfo()
      .then(async ({ port, token }) => {
        const r = await fetch(`http://127.0.0.1:${port}/spike/preview-info`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) throw new Error(`preview-info: ${r.status} (¿backend con APP_BACKEND_SPIKES=1 y APP_BACKEND_SPIKE_COMPOSICION?)`);
        setSrc(`http://127.0.0.1:${port}${((await r.json()) as { ruta: string }).ruta}`);
      })
      .catch((e: Error) => setEstado(e.message));
  }, []);

  useEffect(() => {
    const alRecibir = (e: MessageEvent) => {
      // Solo mensajes del iframe del spike; el origen es «null» (opaco), así que se compara la ventana.
      if (e.source !== ifr.current?.contentWindow) return;
      const m = e.data as Msg;
      if (!m || typeof m.tipo !== "string") return;
      if (m.tipo === "listo") setListo(true);
      if (typeof m.id === "number") pendientes.current.get(m.id)?.(m);
    };
    window.addEventListener("message", alRecibir);
    return () => window.removeEventListener("message", alRecibir);
  }, []);

  const enviar = useCallback((tipo: string, extra: Record<string, unknown> = {}, esperar = false, timeoutMs = 15000) => {
    const id = ++contador.current;
    const ventana = ifr.current?.contentWindow;
    if (!ventana) return Promise.reject(new Error("sin iframe"));
    ventana.postMessage({ tipo, id, ...extra }, "*"); // origen del iframe opaco: no hay otro destino posible
    if (!esperar) return Promise.resolve({ tipo: "enviado" } as Msg);
    return new Promise<Msg>((ok, ko) => {
      const t = setTimeout(() => ko(new Error(`${tipo}: sin respuesta en ${timeoutMs} ms`)), timeoutMs);
      pendientes.current.set(id, (m) => {
        clearTimeout(t);
        pendientes.current.delete(id);
        if (m.tipo === "error") ko(new Error(String(m.motivo)));
        else ok(m);
      });
    });
  }, []);

  const medir = useCallback(async () => {
    setResultados(null);
    const res: Record<string, unknown> = { fecha: new Date().toISOString(), userAgent: navigator.userAgent, escala };
    try {
      setEstado("fps: reproduciendo 10 s…");
      await enviar("seek", { t: 0 }, true);
      await enviar("play");
      await dormir(1000);
      const f = await enviar("medir-fps", { ms: 10000 }, true, 20000);
      await enviar("pause");
      res.fps = { fps: r1(f.fps as number), fotogramas: f.fotogramas, peorIntervaloMs: r1(f.peorIntervaloMs as number) };

      setEstado("seek…");
      const filas: Record<string, number>[] = [];
      for (const t of SEEKS) {
        for (let i = 0; i < REPETICIONES; i++) {
          const a = performance.now();
          const m = await enviar("seek", { t }, true);
          filas.push({ t, viajeMs: performance.now() - a, msSeek: m.msSeek as number, msHastaPintar: m.msHastaPintar as number });
        }
      }
      res.seek = {
        muestras: filas.length,
        medianaViajeMs: r1(mediana(filas.map((x) => x.viajeMs))),
        maxViajeMs: r1(Math.max(...filas.map((x) => x.viajeMs))),
        medianaHastaPintarMs: r1(mediana(filas.map((x) => x.msHastaPintar))),
        maxHastaPintarMs: r1(Math.max(...filas.map((x) => x.msHastaPintar))),
        maxSeekSincronoMs: r1(Math.max(...filas.map((x) => x.msSeek))),
      };

      setEstado("deriva: reproduciendo 50 s…");
      const d = await enviar("medir-deriva", { segundos: 50 }, true, 80000);
      const ms = d.muestras as { pared: number; tl: number; audio: number | null }[];
      const conAudio = ms.filter((x) => x.audio !== null);
      const absAudio = conAudio.map((x) => Math.abs(x.tl - (x.audio as number)) * 1000);
      const absPared = ms.map((x) => Math.abs(x.tl - x.pared) * 1000);
      const ult = ms[ms.length - 1];
      // La pista dura 50,0 s: pasado ese punto el <audio> ya terminó y su currentTime se queda en 50. Se excluye
      // de la regresión. Separa el desfase constante (latencia de salida de audio) de la deriva real (pendiente).
      const vivo = conAudio.filter((x) => (x.audio as number) < 49.5 && x.pared > 1);
      const n = vivo.length;
      const mx = vivo.reduce((a, x) => a + x.pared, 0) / n;
      const dif = vivo.map((x) => (x.tl - (x.audio as number)) * 1000);
      const my = dif.reduce((a, b) => a + b, 0) / n;
      const pendiente = vivo.reduce((a, x, i) => a + (x.pared - mx) * (dif[i] - my), 0) / vivo.reduce((a, x) => a + (x.pared - mx) ** 2, 0);
      res.deriva = {
        muestras: ms.length,
        audioDisponible: conAudio.length > 0,
        maxTimelineVsAudioMs: absAudio.length ? r1(Math.max(...absAudio)) : null,
        // En qué segundo de reproducción está el pico (¿arranque o deriva acumulada?) y cuántas muestras pasan de 33 ms.
        segundoDelPico: absAudio.length ? r1(conAudio[absAudio.indexOf(Math.max(...absAudio))].pared) : null,
        // Con signo (timeline − audio): desfase medio, pendiente (ms por segundo = deriva) y deriva extrapolada a 50 s.
        desfaseMedioMs: r1(my),
        pendienteMsPorSegundo: Math.round(pendiente * 1000) / 1000,
        derivaA50sMs: r1(pendiente * 49),
        rangoDesfaseMs: [r1(Math.min(...dif)), r1(Math.max(...dif))],
        serie: conAudio.filter((_, i) => i % 20 === 0).map((x) => [r1(x.pared), r1((x.tl - (x.audio as number)) * 1000)]),
        muestrasSobre33ms: absAudio.filter((x) => x > 33).length,
        maxTimelineVsAudioTrasPrimerSegundoMs: r1(Math.max(0, ...conAudio.filter((x) => x.pared > 1).map((x) => Math.abs(x.tl - (x.audio as number)) * 1000))),
        finalTimelineVsAudioMs: ult.audio !== null ? r1(Math.abs(ult.tl - ult.audio) * 1000) : null,
        maxTimelineVsRelojMs: r1(Math.max(...absPared)),
        finalTimelineVsRelojMs: r1(Math.abs(ult.tl - ult.pared) * 1000),
        finalTl: ult.tl,
        finalPared: ult.pared,
        finalAudio: ult.audio,
      };
      setEstado("hecho");
    } catch (e) {
      res.error = (e as Error).message;
      setEstado(`error: ${res.error}`);
    }
    (window as unknown as { __spikeResultados: unknown }).__spikeResultados = res;
    setResultados(res);
  }, [enviar, escala]);

  return (
    <main style={{ padding: 16, fontFamily: "system-ui", display: "flex", gap: 16, alignItems: "flex-start" }}>
      <div style={{ width: 1080 * escala, height: 1920 * escala, flex: "none", overflow: "hidden" }}>
        {src && (
          <iframe
            ref={ifr}
            data-testid="preview"
            title="Preview de la composición"
            src={src}
            sandbox="allow-scripts"
            allow="autoplay"
            style={{ width: 1080, height: 1920, border: 0, transform: `scale(${escala})`, transformOrigin: "0 0" }}
          />
        )}
      </div>
      <div style={{ minWidth: 320 }}>
        <h1 style={{ fontSize: 18 }}>Spike D6 · preview en iframe aislado</h1>
        <p data-testid="listo">{listo ? "Runtime listo" : "Esperando al runtime…"}</p>
        <p data-testid="estado">{estado}</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
          <button onClick={() => void enviar("play")}>Play</button>
          <button onClick={() => void enviar("pause")}>Pause</button>
          {[0, ...SEEKS].map((t) => (
            <button key={t} onClick={() => void enviar("seek", { t })}>
              Seek {t} s
            </button>
          ))}
        </div>
        <button data-testid="medir" disabled={!listo} onClick={() => void medir()} style={{ padding: "8px 16px", fontWeight: 700 }}>
          Medir (≈ 1 min 10 s)
        </button>
        <pre data-testid="resultados" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
          {resultados ? JSON.stringify(resultados, null, 2) : ""}
        </pre>
      </div>
    </main>
  );
}
