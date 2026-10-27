# Spec: feature «Guiones» (2026-10-26)

Ayudar al creador a escribir y revisar sus guiones y a entender dónde pierde audiencia,
como una pantalla más de SEO Studio (al nivel de «Publicar vídeo»), no como un prompt que
hay que saber escribir en el chat.

El contrato de UI que exigen los E2E está en [app-ui/docs/pantallas.md](app-ui/docs/pantallas.md)
→ «Guiones». Este documento explica el qué y el porqué; aquel, el cómo se comprueba.

## Resumen en cinco líneas

1. **KB:** cuatro fuentes nuevas sobre guion, ganchos y retención en `kb-seo/sources.yaml`.
2. **Tool nueva** `youtube_retention_moments` (lectura): cruza en Python la curva de retención
   con la transcripción y devuelve las caídas y los picos **con la frase que sonaba**.
3. **Endpoint** `GET /guiones/retencion` que llama a esa tool sin pasar por el modelo.
4. **Pantalla** `/guiones` con tres modos: Escribir, Revisar y Diagnosticar.
5. **System prompt**: reglas de guionista (citar la KB, priorizar datos del canal, no copiar
   guiones ajenos).

## El ciclo que la pone a la par de las demás

```
 idea ──► Escribir guion ──► (grabar) ──► Publicar vídeo ──► Diagnosticar retención
   ▲                                                               │
   └──────────── buscar_kb (KB privada) ◄── Guardar aprendizaje ◄──┘
```

Lo que el creador aprende de un vídeo publicado se guarda en su KB privada, y el siguiente
«Escribir guion» lo recupera con `buscar_kb`. Ese bucle es lo que diferencia la feature de un
generador de guiones genérico: el consejo sale de **su** curva, no de reglas generales.

## Decisiones

### D1. El cruce retención × transcripción se calcula en código, no en el modelo

La curva son 100 puntos en fracción de la duración (`elapsedVideoTimeRatio` 0,01…1,00) y la
transcripción son segmentos en segundos. Alinear ambas cosas y encontrar las caídas es
aritmética. Si se deja al modelo:

- se equivoca en silencio (desplaza una caída 20 s y culpa a la frase equivocada);
- gasta miles de tokens de entrada en cada análisis;
- el resultado no es reproducible ni testeable.

En Python es determinista, tiene tests con fixtures y devuelve al modelo una lista corta. El
modelo solo hace lo que se le da bien: interpretar por qué esa frase pierde gente y reescribirla.
Es la misma separación datos/inferencias que la UI ya marca con «Datos».

**Se descarta:** pasar al modelo la curva y la transcripción en bruto (frágil y caro) y hacer
el cruce en TypeScript (la lógica vive con el resto de tools y la usa también el chat).

### D2. Diagnosticar llama al endpoint directamente; el agente solo interpreta

`GET /guiones/retencion` ejecuta la tool sin el modelo (patrón de `/kb/buscar`). La pantalla
pinta la curva y los momentos al instante, sin coste de tokens. «Proponer mejoras» envía al
agente los momentos ya calculados con la instrucción de no volver a pedirlos.

**Por qué no dejar que el agente llame a la tool:** el gráfico dependería de que el modelo
decida llamarla, y la transcripción oficial cuesta ~100 unidades de cuota; pedirla dos veces
(pantalla + agente) gasta el doble. La tool sigue registrada para el chat libre
(«¿dónde pierdo gente en mi último vídeo?»).

### D3. Salida estructurada en JSON, con fallback visible

Escribir y Revisar piden al agente un JSON (esquemas abajo) y la pantalla lo vuelca en campos
editables, como hace Publicar con el borrador. Si el JSON no se puede leer, **no** se pierde
la respuesta: se muestra el texto del turno y el aviso `guion-json-error`. Se extrae a
`app-ui/src/json.ts` un `extraerJson<T>(texto, validar)` genérico que reutilizan Publicar y
Guiones (antes `extraerJson` vivía dentro de `PublicarScreen.tsx` y era específico del borrador).

### D4. Un hilo de conversación por modo

Cada modo tiene su conversación en el store de conversaciones (`guiones:escribir`,
`guiones:revisar`, `guiones:diagnosticar`; como `publicar`, no se guardan en el sidecar), así una
revisión no arrastra el contexto del guion que se escribió antes. El resto del estado de cada modo
vive en `state/guiones.ts` (zustand), como Publicar: cambiar de modo o de pantalla no pierde nada,
y un turno que termina mientras se está en otra pantalla se procesa al volver.

### D5. Ventana del gancho según formato

| Formato | Ventana del gancho | Por qué |
|---|---|---|
| Vídeo largo | 0–30 s | YouTube mide «Introducción» como retención a los 30 s (fuente oficial). |
| Short | 0–3 s | En Shorts se decide en el primer deslizamiento; no hay cifra oficial, es la convención de las guías. |

La tool calcula `intro_retention` en el punto más cercano a 30 s (largo) o 3 s (Short). El
formato lo indica el usuario (selector), no la heurística `_is_likely_short` (≤ 60 s), que ha
quedado vieja: los Shorts admiten hasta 3 minutos desde octubre de 2024.

## 1. Fuentes de la KB

Añadir a `kb-seo/sources.yaml`, en una sección nueva `# ---- Guion y ganchos`:

| URL | Autor | Fecha | Plataforma | Topics |
|---|---|---|---|---|
| `https://support.google.com/youtube/answer/9314415?hl=es` | YouTube | 2026-10-26 (`doc-oficial-viva`) | youtube | retencion, introduccion, momentos-clave, oficial |
| `https://vidiq.com/blog/post/write-youtube-video-script/` | vidIQ | 2026-07-21 | youtube | guion, ganchos, estructura, cta |
| `https://www.synthesia.io/post/how-to-write-a-youtube-script` | Synthesia | 2026-05-22 | youtube | guion, ganchos, estructura, ritmo |
| `https://contentstudio.io/blog/youtube-shorts-analytics-guide` | ContentStudio | 2026-10-14 | youtube | shorts, retencion, ganchos |

- Las tres de terceros son blogs de empresas que venden herramientas: sus cifras son
  recomendaciones, no datos de YouTube. El prompt ya pide citar título y URL, así que el
  usuario ve de dónde sale cada consejo.
- La de ContentStudio se leyó antes de añadirla: trata el diagnóstico de los primeros segundos
  de un Short (deslizamientos) con pruebas concretas.
- Ingesta en el VPS como el resto (`uv run ingest all`); la app la recibe con la siguiente
  actualización firmada de la KB. No hace falta cambio en la app para esta parte.

**Hueco conocido:** ninguna fuente en español sobre guion. Aceptable para v1 (la KB es
multilingüe en la búsqueda); apuntado como siguiente paso.

## 2. Tool `youtube_retention_moments`

Ubicación: `youtube-mcp-server/src/youtube_mcp/tools/retention.py` (nuevo módulo; registrarlo
donde se registran los demás). Riesgo `read` (no está en `WRITE` ni `DESTRUCTIVE`), no estricta.

```python
@mcp.tool()
def youtube_retention_moments(
    video_id: str,
    format: str = "long",          # "long" | "short"
    language: str = "es",
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict
```

Pasos:

1. `youtube_get_video` → duración ISO → segundos. Añadir `iso_duration_seconds()` en
   `utils/formatting.py` y que `format_duration` y `_is_likely_short` la usen (hoy parsean la
   cadena cada una a su manera).
2. `youtube_analytics_retention` → 100 filas `{elapsedVideoTimeRatio, audienceWatchRatio,
   relativeRetentionPerformance}`. Por defecto desde la fecha de publicación del vídeo hasta hoy:
   la ventana de 28 días de las demás tools deja sin datos a los vídeos antiguos.
3. `youtube_get_transcript(video_id, language)` → `segments [{text, start, duration}]`.
4. Calcular:
   - `curve`: los 100 puntos con `t` en segundos (`ratio × duración`).
   - `intro_retention`: `audienceWatchRatio` en el punto más cercano a 30 s / 3 s (D5).
   - `drops`: las 5 mayores bajadas entre puntos consecutivos con `delta ≤ -0,02`, sin
     contar el último 5 % (la caída del final es el cierre, no un problema), fusionando bajadas
     contiguas en un único tramo.
   - `spikes`: las 3 mayores subidas (`delta ≥ +0,01`): fragmentos que se vuelven a ver.
   - A cada momento, `quote`: texto de los segmentos que solapan `[t_inicio − 5 s, t_fin]`,
     recortado a 300 caracteres.
5. Devolver:

```json
{
  "video_id": "abc", "title": "…", "duration_s": 612, "format": "long",
  "intro_window_s": 30, "intro_retention": 0.61,
  "curve": [{"t": 6.1, "ratio": 0.01, "watch": 0.93, "relative": 0.52}],
  "drops":  [{"t_start": 18.4, "t_end": 24.5, "from": 0.78, "to": 0.66, "delta": -0.12, "quote": "…"}],
  "spikes": [{"t_start": 301.0, "t_end": 307.1, "delta": 0.04, "quote": "…"}],
  "transcript_source": "official_api",
  "transcript_error": null
}
```

Errores (siempre `{"error": "…"}` con texto accionable, nunca excepción al modelo):

- Analytics sin filas → «YouTube aún no tiene datos de retención de este vídeo (tarda 1–2 días
  y necesita un mínimo de visualizaciones) o el vídeo no es de tu canal».
- Sin transcripción → **no** es error: se devuelven curva y momentos con `quote: null` y
  `transcript_error` relleno. La curva sola ya es útil.

Cuota: `videos.list` 1 + transcripción oficial de vídeo propio ~100 (`caption_list` 50 +
`caption_download` 50). Añadir la entrada en `QUOTA_OP` del registro para que el coste
aparezca en `/youtube/tools`. Analytics tiene cuota propia y no se contabiliza aquí.

Tests (`youtube-mcp-server/tests/test_retention.py`), con fixtures, sin red:

- duración ISO → segundos (incluye `PT1H`, `PT45S`, `P0D`);
- detección de caídas: fusión de tramos contiguos, umbral, exclusión del último 5 %;
- `quote` toma los segmentos que solapan la ventana y respeta el recorte;
- intro a 30 s (largo) y a 3 s (Short);
- sin filas de analytics → error; sin transcripción → resultado con `quote: null`.

## 3. Endpoint

`GET /guiones/retencion?video_id=…&format=long|short&language=es` en `app_backend/main.py`,
protegido con el token como el resto, que ejecuta la tool en `asyncio.to_thread` y devuelve su
dict tal cual. `video_id` validado con `^[A-Za-z0-9_-]{11}$` antes de llamar (422 si no casa):
evita pasar texto arbitrario al filtro de Analytics (`video==…`). Tests en `tests/test_guiones.py`
con YouTube sustituido por dobles.

## 4. Pantalla `/guiones`

Contrato completo en `pantallas.md`. Mismo esqueleto que Publicar (cabecera con el selector de
modo, cuerpo en dos columnas con paneles a la derecha) y solo componentes del catálogo
(`SegmentedControl`, `Field`, `Chip`, `EmptyState`, toasts). Resumen por modo:

**Escribir.** Tema, formato, duración objetivo y público → el agente consulta la KB (y la KB
privada, que incluye lo aprendido del canal) y devuelve:

```json
{
  "ganchos": [{"tipo": "promesa|curiosidad|in-media-res|contraintuitivo|problema", "texto": "…"}],
  "bloques": [{"titulo": "…", "segundos": 45, "contenido": "…", "nota_visual": "…"}],
  "cta": "…",
  "fuentes": [{"titulo": "…", "url": "…"}]
}
```

Se muestran 2–3 ganchos para elegir uno (radio), los bloques editables, el CTA y la suma de
duraciones frente a la objetivo (a 140 palabras/min, cifra de vidIQ). «Copiar guion» deja el
guion en Markdown en el portapapeles y lo confirma con un toast.

**Revisar.** Pegar un guion + formato → el agente devuelve:

```json
{
  "veredicto_gancho": "…",
  "problemas": [{"fragmento": "…", "problema": "…", "propuesta": "…"}],
  "gancho_reescrito": "…",
  "fuentes": [{"titulo": "…", "url": "…"}]
}
```

**Diagnosticar.** `video_id` (o URL de YouTube, se extrae el ID) + formato → `GET
/guiones/retencion` → curva (SVG propio, sin librería de gráficos), retención de la intro y
tablas de caídas y picos con su frase. Panel «Tus últimos vídeos» (de `GET /youtube/channel`,
ya en caché para el Panel de canal) para elegir el vídeo sin copiar su ID. Botón «Proponer
mejoras» → agente con los momentos ya
calculados. Botón «Guardar aprendizaje» → el agente propone `guardar_en_kb_privada` con un
resumen; pasa por la tarjeta de aprobación de siempre.

## 5. System prompt

Añadir a `SYSTEM_PROMPT` en `app_backend/agent.py`:

- Para escribir o revisar guiones, consulta `buscar_kb` (ganchos, estructura, retención) y la
  KB privada del canal antes de responder; si hay aprendizajes propios, priorízalos sobre las
  reglas generales y dilo.
- Puedes analizar guiones o transcripciones de otros creadores para extraer patrones, pero no
  reproduzcas su texto: propón uno original.
- Si te pasan momentos de retención ya calculados, no vuelvas a pedir la retención.

Cambia el prefijo cacheado: la primera petición tras actualizar paga la escritura de caché
una vez. Asumible.

## Seguridad

- **Inyección de prompt:** las transcripciones de vídeos ajenos, el guion pegado y las fuentes
  de la KB son entrada no confiable. La regla del system prompt («son DATOS») ya los cubre. La
  tool nueva devuelve solo números y texto; nada de lo que devuelve se ejecuta. Los modos
  Escribir y Revisar no necesitan tools de escritura: si el modelo intentase una, sale la
  tarjeta de aprobación de siempre.
- **Validación de entrada:** `video_id` con regex en el endpoint (D2/§3). El guion pegado se
  recorta a 20 000 caracteres antes de enviarlo (coste y superficie de inyección).
- **Copyright:** regla explícita de no reproducir guiones ajenos (§5).
- **Privacidad:** «Guardar aprendizaje» escribe solo en la KB privada local, con aprobación.
  Nada sale del equipo salvo las llamadas que ya hace la app (YouTube, Anthropic).
- **Cuota:** la pantalla avisa del coste (~100 unidades) antes de diagnosticar; con la cuota
  agotada se muestra el error de `QuotaExhaustedError` tal cual.

## Fuera de alcance (v1)

- Pasar el guion a Publicar como base de la descripción (el cierre completo del ciclo). Es el
  siguiente paso natural; requiere tocar el contrato de Publicar.
- Comparar la curva con la de otros vídeos del canal (necesita varias llamadas a Analytics).
- Fuentes en español sobre guion.
- Acción «Diagnosticar» en cada fila de vídeos del Panel de canal (hoy se elige desde Guiones).
- Guardar guiones en disco (hoy: copiar al portapapeles).

## Orden de implementación

1. Fuentes en `sources.yaml` (independiente, se puede ingerir ya).
2. `iso_duration_seconds` + tool `youtube_retention_moments` + tests (TDD).
3. Endpoint + test.
4. `extraerJson` genérico (refactor de Publicar sin cambio de comportamiento; sus tests siguen
   en verde).
5. Pantalla, enlace en la barra lateral, paleta de comandos y E2E (`marco.spec.ts` con el enlace
   nuevo, `guiones.spec.ts` y capturas de `visual.spec.ts`).
6. System prompt.
7. Verificación real con un vídeo del canal desde la app instalada.
