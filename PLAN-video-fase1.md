# Módulo Vídeo · Fase 1: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pasar de un guion en modo vídeo (Guiones) a un MP4 vertical verificado, con voz por frases, escenas de duración variable, perfil visual y un editor con preview real y timeline de cinco pistas.

**Architecture:** El motor (TypeScript) es la única autoridad del esquema y de la carpeta del proyecto: el backend solo reenvía JSON acotado por MCP, y la UI nunca ve rutas. `planificarComposicion` pasa de 6 bloques a N escenas, con un adaptador para que las comparaciones de fotogramas existentes prueben el cambio. La preview se sirve desde un puerto propio con URL de capacidad y se controla por `postMessage`.

**Tech Stack:** TypeScript + zod + HyperFrames 0.8.206 (motor); FastAPI + MCP stdio + SQLite (backend); Tauri 2.12 + Rust (nativo); React 19 + zustand + TanStack Query (UI); vitest, pytest, Playwright.

**Spec:** `SPEC-video.md` (D3–D11, Seguridad I1–I15, criterios de la fase 1). Modelo de amenazas y protocolo R0/R1/R2: `HANDOFF-video-fase1.md` §2 y §3. Contrato de UI: `app-ui/docs/pantallas.md`.

**Estado de este plan:** borrador para la revisión R0 y la aprobación de Marc. No se implementa nada hasta entonces.

## Global Constraints

- Duración ≤ 180 s, ≤ 90 escenas, ≤ 3000 caracteres de narración, ≤ 30 recursos (I1). 1080×1920 a 30 fps. Aspecto `9:16` como campo del proyecto, único valor admitido (D3).
- El modelo solo produce JSON de escenas. Nunca dispara voz ni render (D2, I10). Ninguna tool `video_*` entra en `registry.build()`. Las tools estrictas siguen ≤ 20 y ≤ 12 uniones (`test_registry.py`).
- La salida del modelo nunca se pinta como HTML. Nada de `innerHTML` ni `dangerouslySetInnerHTML` en `app-ui/src/video/`.
- El WebView sigue con `core:default`: lo nativo va por comandos Rust. La UI nunca envía rutas (I6).
- `data-testid` nuevos en `pantallas.md`, con su E2E en el mismo commit. Solo componentes del catálogo `ui/` y tokens.
- Sin dependencias nuevas en npm, pnpm ni uv. La única candidata es la de la decisión M-D4. `zod` ya está en el motor.
- Node, ffmpeg y Chrome solo desde rutas fijas (I4). Hijos con `ejecutar()`, entorno por lista blanca (I5, I13). Toda entrada de ffmpeg con `argsEntrada()`.
- Salidas de red: solo las de I14. Nada de `npx` sin versión ni `@latest`.
- ffmpeg LGPL: encoders `prores_ks h264_mf h264_nvenc h264_amf aac png pcm_s16le rawvideo`. Sin `libmp3lame`, `mjpeg`, `silencedetect`, `boxblur` ni filtro `concat`. Filtros disponibles en `ffmpeg-build/componentes.conf`.
- Código, tests y commits en español con acentos. «ejecución», nunca «corrida». Ramas `feat/<nº>-<slug>` desde `feat/video-fase1`. Commits a nombre de Marc, ≤ 72 caracteres, sin atribución.
- Sin push ni PR sin el sí de Marc. No se ejecuta el instalador. `pnpm e2e` y `pnpm tauri` solo desde Git Bash.

## Review Focus

1. **Texto válido que rompe el diseño** (palabra de 80 letras, emoji, árabe): cabe o se avisa, nunca se desborda en silencio. Test: `test_texto_limite_cabe` en T3.
2. **Lote de voz cortado a media ejecución** (429 o sin créditos en la frase 7 de 20): lo hecho se conserva y reintentar factura solo lo que falta. Test: `reintento_no_refactura` en T5.
3. **Autoguardado en carrera** (ediciones rápidas, dos pestañas lógicas, cierre a mitad): la revisión gana y un 409 recarga sin perder la edición local. Tests: `revision_antigua_409` en T4 y `editor-conflicto` en T16.
4. **Borrar lo que está en uso** (recurso en una escena, proyecto con preview abierta o render en curso): 409 legible o invalidación de la clave. Tests: `recurso_en_uso_409`, `borrar_invalida_clave` y `borrar_con_render_409` en T11.
5. **Vídeo de 180 s con 90 escenas**: composición, seek y `check` dentro de límites medidos, con las capas fijas encima de todas las escenas. Tests: `noventa_escenas_orden_z` en T3 y `rendimiento_180s` en T21.

---

## Decisiones que necesitan a Marc

Sin M-D1, M-D2 y M-D5 no empieza la implementación. En las demás se aplica la recomendación salvo que digas otra cosa, y M-D4 necesita además tu permiso de descarga.

| ID | Decisión | Recomendación y motivo | Qué se sacrifica |
|---|---|---|---|
| **M-D1** | Origen de la preview. El ruling W1.2 LOW-9 pide `frame-src` exacto «ajustado al recibir la URL», pero **una página no puede relajar su propia CSP**, y el puerto del sidecar es aleatorio. | **Puerto propio de una lista fija** (`47810–47813`) en `tauri.conf.json`. Es estático, se prueba leyendo el fichero, funciona igual en desarrollo y separa la preview de la API: la composición no alcanza la API ni sin bearer. Descartados: `127.0.0.1:*` (una composición comprometida navegaría su iframe a Ollama o LM Studio) y el hook `on_web_resource_request` (exige `create:false`, recargar la app al conocer el puerto, y no lo cubre ningún E2E). | Si los cuatro puertos están ocupados, no hay preview y se dice. Enmienda I8. |
| **M-D2** | CA1 pide dos perfiles y D8 dice uno en la fase 1. | **Lista simple de perfiles** (`perfiles/<id>.json`, «Duplicar», y el proyecto referencia uno). Es lo que D8 llama fase 3, sin importar ni IA: evita migrar datos. | Enmienda D8. Algo más de UI en la fase 1. |
| **M-D3** | Botón de escuchar voz (D7). `preview_url` de ElevenLabs apunta a un host fuera de I14. | **Muestra generada con la voz** (60 caracteres fijos, coste visible, caché por voz). No abre salidas de red nuevas. | Gasta créditos del usuario. La alternativa es ampliar I14 con un host que elige una respuesta no confiable. |
| **M-D4** | Dos instancias de la app (M-4, condición de `VIDEO_ENGINE=1`). | **`tauri-plugin-single-instance`**, como pidió la R0: enfoca la ventana abierta. Necesita descargarlo: **pide tu permiso** y justificación I9. Si no lo das: mutex con `windows-sys` (`CreateMutexW`, ya disponible), sin enfocar la ventana. | Una dependencia y una descarga. |
| **M-D5** | Enmiendas pendientes de la spec: M-1 (I2 b, bypass solo al puerto), M-2 (I4, `debug.log`), M-3 (I7, barrido), W1.3 y W1.6 (riesgos residuales), W1.5 (I4 ffmpeg sustituible, frontera de construcción). | Aprobarlas con T0: el código ya las cumple y la spec vinculante no. | Nada: alinea texto y realidad. |
| **M-D6** | Automático = Compatible y bitrate (D11). `h264_mf` ignora el bitrate. | Mantener Compatible y medir con fotos reales antes de publicar. La medición es tuya, en tu GPU. | Renders más lentos (782 s frente a 517 s por 50 s). |
| **M-D7** | Clips horizontales «sobre fondo desenfocado» (D9). El ffmpeg LGPL no tiene `boxblur` ni `gblur`. | **CSS `filter: blur()` sobre un fotograma fijo del clip** en `capa-clip.html`. No toca el build de ffmpeg. | El fondo no se mueve. Añadir `gblur` exige recompilar y volver a pasar W3.2. |
| **M-D8** | `tunel` no está en la lista de D4 pero la pieza existe. | **Fuera del esquema del modelo en la fase 1**, porque exige tres fotos. La pieza sigue probada por el adaptador. | Una escena menos. Entra en la fase 2 sin coste. |
| **M-D9** | Formato `guion.md` y 6 bloques. | **Sin registrar en integrado** y conservado como adaptador de tests hasta la fase 2: las SSIM siguen protegiendo las piezas. | Código viejo vivo una fase. |

**Pasos manuales de Marc:** M2 (preview en WebView2 con la RTX, necesaria para CA4 con WebGPU), M-5 (test de sockets desde un terminal externo), clips H.264 en WebView2 (Playwright y CfT no traen H.264), CA8 en un equipo sin GPU, y pruebas con la app instalada.

---

## Entrada y orden

**Condiciones de entrada.** El ledger llega hasta la oleada 2. La oleada 3 sigue abierta, así que la premisa del handoff («todo integrado») **hoy no se cumple**:

| Pieza | Qué necesita este plan | Bloquea |
|---|---|---|
| W3.1 (T1–T5) | `validarTema`, `urlsDeRed` con speculationrules, sin GSAP | T3, T8 |
| W3.4 (T1, T2, T4) | `copiarRecurso`, `comprobarRecurso`, `validarPalabras`, alineación validada | T5, T7 |
| W3.2 | ffmpeg LGPL en el bundle. **Depende de T2**: el `LEEME` de `ffmpeg-build` lo bloquea hasta quitar `libmp3lame` y ese trabajo no tenía dueño | T21 |
| W3.5 | Borrado del spike, tras M2. No bloquea: `preview.py` no lo importa | T21 |
| R2 de oleadas 2 y 3 | Sin Critical ni High abiertos | T9 |

**Carriles y propiedad.** Un carril = un implementador en serie, en su worktree. Carriles distintos corren en paralelo porque sus archivos son disjuntos y la interfaz queda fijada en T1 y en la tabla REST de T9. Backend y UI usan motores y rutas simuladas hasta integrar.

| Carril | Tareas | Escribe en exclusiva | Depende de |
|---|---|---|---|
| **0** Orquestador | T0 | `SPEC-video.md`, Plane | Decisiones de Marc |
| **M** Motor | T1 → T8 | `video-mcp-server/**` | T0, W3.1, W3.4 |
| **B** Backend | T9 → T11 | `app-backend/**` | T1 (interfaz), R2 |
| **R** Rust | T12 → T13 | `app-ui/src-tauri/**` | M-D1, M-D4 |
| **U0** Contrato | T14 | `pantallas.md`, `src/api/*`, `src/App.tsx`, `src/shell/Sidebar.tsx`, `src/CommandPalette.tsx`, `src/video/modelo.ts`, `src/state/editor.ts`, `e2e/video-comun.ts`, `e2e/elevenlabs-mock.ts`, `e2e/global-setup.ts` | T9 (tabla REST) |
| **U1** | T15 | `src/guiones/*`, `src/state/guiones.ts`, `e2e/video-guion.spec.ts` | T14 |
| **U2** | T16 → T17 | `src/screens/Video*`, `src/screens/EditorVideo*`, `src/video/Editor*`, `src/video/preview*`, `src/video/Preview*`, `e2e/video-editor.spec.ts`, `e2e/video-preview.spec.ts` | T14, T10 |
| **U3** | T18 | `src/video/panel/**` | T16 (interfaz) |
| **U4** | T19 | `src/video/timeline/**` | T16 (interfaz) |
| **U5** | T20 | `src/video/render/**`, `src/screens/MotorVideo*`, `src/state/renderModo.ts`, `e2e/motor-video.spec.ts`, `e2e/video-render.spec.ts` | T14, T11 |
| **Cierre** | T21 | `e2e/visual.spec.ts` y capturas, `scripts/smoke_test.py`, `test/fidelidad-preview.test.ts` | Todo |

**Puerta de seguridad:** T1, T3 y T9 forman la primera vía de guion a composición. Tienen R0 propia sobre este plan **antes de T1** y R1 conjunta del diff **antes de integrar T9**. Mientras no pase, T9 vive solo en su rama.

**Plane:** antes de T1 el orquestador crea una subtarea de SEO-107 por tarea. Los commits llevan ese número, indicado aquí como `(SEO-xx)`.

**Comandos:** motor `cd video-mcp-server && npx vitest run <test>`; backend `cd app-backend && uv run --extra dev pytest -q <test>`; UI `cd app-ui && pnpm test <test>`; E2E `cd app-ui && pnpm e2e <spec>`.

---

## Carril 0

### Task 0: Enmiendas de la spec

**Files:** Modify `SPEC-video.md` (I2 b, I4, I7, I8, D8, D9, D4, diagrama de fronteras). Crear subtareas en Plane.

- [ ] **Step 1:** Registrar las respuestas de Marc a M-D1…M-D9. Sin M-D1, M-D2 y M-D5, parar.
- [ ] **Step 2:** Aplicar en la spec solo lo aprobado. I8 con el texto: «`frame-src` lista exactamente los puertos de preview fijados en `tauri.conf.json`; nunca `127.0.0.1:*`».
- [ ] **Step 3:** Lanzar la R0 de este plan con el `cyber-security-auditor`, pasándole §2 del handoff y los archivos, no estas conclusiones. Incorporar los cambios aquí.
- [ ] **Step 4: Commit.** `Spec: enmiendas de seguridad de la fase 1 (SEO-xx)`

---

## Carril M · Motor

### Task 1: Esquema del guion y del proyecto

**Files:**
- Create: `video-mcp-server/src/esquema.ts`
- Test: `video-mcp-server/test/esquema.test.ts`

**Interfaces:**
- Produces, y con esto se congela la interfaz de los carriles B y U:
```ts
export const LIMITES = { duracionS: 180, escenas: 90, narracion: 3000, recursos: 30, frasesPorEscena: 6,
  fraseChars: 400, tituloChars: 100, ganchoChars: 80, queDebeSalirChars: 200 } as const;
export const TIPOS_ESCENA_FASE1 = ["cifra", "barras", "mapa", "cartel", "titulo3d"] as const;
export function validarGuionVideo(v: unknown): GuionVideo;       // lanza ErrorEsquema
export function validarProyecto(v: unknown): Proyecto;           // al guardar y al cargar (I1)
export function recomendaciones(g: GuionVideo | Proyecto): Aviso[];   // D3, nunca bloquean
export function descripcionEsquema(): string;                    // para el prompt: fuente única
export class ErrorEsquema extends Error { problemas: { ruta: string; codigo: string }[] }  // sin valores
```
- `GuionVideo`: `{ version: 1, titulo, gancho, escenas: [{ frases: string[], base: EscenaBase, recurso?: { tipo: "foto"|"clip", que_debe_salir, resolucion_minima: { ancho, alto } } }], opciones: { fondo, look, subtitulos, etiqueta?, destellos, golpe?: { frase, palabra } } }`.
- `Proyecto`: `{ version: 1, id, revision, titulo, gancho, aspecto: "9:16", perfilId, creado, actualizado, frases: [{ id, texto, recorte? }], escenas: [{ id, fraseIds, base, ajusteCorte, capa?, recursoPendiente? }], recursos: [{ id, clase, ext, nombreOriginal, ancho, alto, duracion }], musica?: { pistaId, inicio, volumen, ducking }, subtitulos: { estilo, correcciones, cortes }, opciones }`.
- `EscenaBase`: unión discriminada por `tipo`, con los campos de `formato.ts` y `series` como **array** `{ nombre, valores }`, no mapa.

**Seguridad.** I1, I6. El esquema **no tiene campos de ruta ni URL**. Todo objeto va con `.strict()`. El texto pasa por `textoSeguro`: NFC y sin C0, C1, bidi (`U+202A–202E`, `U+2066–2069`) ni surrogados sueltos. No se rechaza `<`: lo cubre el escape, y la spec pide verlo escapado. Números finitos y acotados (`valor` en ±1e12). `ErrorEsquema` nunca lleva el valor, para que no llegue a logs ni a la UI como texto del atacante.

- [ ] **Step 1: Escribir los tests, que fallan.** `guion_valido_pasa` (fixtures de fútbol y cocina). `sobra_un_campo` (`{ruta: "x"}` en cualquier nivel → `unrecognized_keys`). `sin_campos_ruta`: recorre el esquema y falla si existe `ruta`, `url`, `path`, `src` o `archivo`. `limites_exactos`: 90 escenas pasan, 91 no; 3000 caracteres pasan, 3001 no. `numero_no_finito` (`1e400`, `"12"`, `null`). `proto` (`JSON.parse('{"__proto__":{"x":1}}')` → rechazado). `color_malo_rechazado` en `validarProyecto`. `texto_control` (`"a\u202Eb"`, `"a\u0000"`). `script_pasa_como_texto` (`<script>` válido). `error_sin_valor`: `JSON.stringify(e.problemas)` no contiene el centinela. `mapa_fuera_de_atlas` usa `resolverZona`. `tunel_rechazado`. `recurso_id_regex`: `../x`, `C:\x`, `a:b`.
- [ ] **Step 2: Ejecutar.** `npx vitest run test/esquema.test.ts`. Esperado: FAIL, módulo inexistente.
- [ ] **Step 3: Implementar con zod.** `recomendaciones`: corte cada 2–4 s, gancho en los 3 primeros segundos, última frase que enlace con el inicio. Se estima con 14 caracteres/s y nunca lanza.
- [ ] **Step 4: Ejecutar.** Esperado: PASS.
- [ ] **Step 5: Commit.** `Motor: esquema estricto de guion y proyecto (SEO-xx)`

### Task 2: Audio interno en WAV, sin LAME

**Files:**
- Modify: `video-mcp-server/src/musica.ts:49-65`, `src/composicion.ts:550-557`, `src/render.ts:333-366`, `ffmpeg-build/componentes.conf` (`FF_EXCLUIDOS_CONOCIDOS`)
- Test: `video-mcp-server/test/ajustes7a.test.ts`, `ffmpeg-build/tests/componentes.test.sh`

**Interfaces:** `normalizarVoz` y `prepararMusica` escriben `pcm_s16le` a 44,1 kHz con `-f wav`. La composición usa `assets/voz.wav` y `assets/musica.wav`.

**Por qué WAV y no AAC:** sin retardo de codificador, seek exacto al sample y lo reproduce el Chromium de Playwright, que no trae AAC. El MP4 final sigue en AAC por la segunda pasada.

**Seguridad.** I12. Además desbloquea W3.2.

- [ ] **Step 1: Tests.** `sin_lame`: `grep` en `src/` de `libmp3lame` da 0. `voz_normalizada_es_wav` con ffmpeg real. `composicion_referencia_wav`.
- [ ] **Step 2: Ejecutar.** Esperado: FAIL.
- [ ] **Step 3: Implementar** y dejar vacío `FF_EXCLUIDOS_CONOCIDOS`.
- [ ] **Step 4: Ejecutar** el test y `npm run render:mock`. Esperado: PASS. `verificarMp4` sigue exigiendo audio.
- [ ] **Step 5: Commit.** `Motor: audio interno en WAV, sin libmp3lame (SEO-xx)`

### Task 3: Composición de N escenas

**Files:**
- Modify: `video-mcp-server/src/composicion.ts` (`:183-581`), `src/alineacion.ts:187`, `plantilla/piezas/escena-mapa.html`
- Create: `video-mcp-server/src/linea.ts`
- Test: `video-mcp-server/test/composicion.test.ts`, `test/generico.test.ts`, `test/piezas-w23.test.ts`

**Interfaces:**
- Consumes: `Proyecto` (T1), `validarTema` (W3.1).
- Produces:
```ts
export interface EntradaPlan { titulo: string; gancho: string; escenas: EscenaPlan[]; opciones: OpcionesPlan;
  palabras: ResultadoAlineacion; tema: Tema; musica?: {...}; cortes?: number[]; gpu: boolean }
export function planificarComposicion(e: EntradaPlan): PlanComposicion;
export function desdeGuionV2(g: Guion, imagenes): Pick<EntradaPlan, "titulo"|"gancho"|"escenas"|"opciones">;  // ponytail: adaptador de tests, se borra en la fase 2
export function construirLinea(p: Proyecto, voz: Map<string, VozFrase>): ResultadoAlineacion;  // linea.ts
```

Cambios fijados:
- Se quitan todos los `[1..6]`, `k === 5`, `slice(0, 5)` y `palabras.segmentos.length !== 6`.
- Ids HTML **por índice** (`esc1…esc90`), nunca desde `Proyecto`.
- Capas fijas por encima de cualquier escena: bucle 199, capas 200, gancho 210, etiqueta 211, subtítulos 220, flash 230. Hoy `10 + n` pasaría de 40 con 31 escenas.
- `piezaMapa` añade `empieza` a `DATOS` y la pieza lo usa (bug de W2.3). Cambio visual solo en mapa: actualizar la referencia.
- `construirLinea` suma los tiempos de cada frase aplicando `recorte` y `ajusteCorte` ajustado a la palabra más cercana.

**Seguridad.** I1, I2. Cada valor con el escape de su contexto, sustitución en una pasada. El plan valida el tema y los tiempos antes de escribir nada. `escribirPlan` no cambia: rechaza que `rel` salga de `destino`.
**Negativas:** `script_y_llaves_escapados` (`<script>`, `{{ID}}`, `</script>` y `"><img>` en cada campo de texto de cada tipo: ninguno aparece sin escapar en ningún fichero). `sin_url_de_red` (`http://x` en todos los textos: `urlsDeRed` solo ve datos escapados y el render no lo interpreta). `clave_no_llega` (centinela en `ELEVENLABS_API_KEY`: ausente de `archivos`). `numero_no_finito_lanza`.

- [ ] **Step 1: Tests que fallan.** Las negativas anteriores, más `n_escenas` (1, 6, 12, 90), `noventa_escenas_orden_z` (subtítulos por encima de `esc90`), `ids_por_indice`, `test_texto_limite_cabe` (palabra de 80 letras, emoji, árabe: `tamanoGancho` ≥ mínimo y aviso si no cabe) y `sin_6_literal`.
- [ ] **Step 2: Ejecutar.** Esperado: FAIL.
- [ ] **Step 3: Implementar** el cambio de `EntradaComposicion` a `EntradaPlan`.
- [ ] **Step 4: Ejecutar.** `npm test` y `npx vitest run test/piezas-w21.test.ts test/piezas-w22.test.ts test/piezas-w23.test.ts test/piezas-w24.test.ts test/piezas-w25.test.ts`. Esperado: PASS, con SSIM ≥ 0,99 y sin bajar umbrales. El adaptador es lo que convierte estas pruebas en la red del cambio.
- [ ] **Step 5: Commit.** `Motor: composición de N escenas con ids por índice (SEO-xx)`

### Task 4: Almacén de guiones y proyectos

**Files:**
- Create: `video-mcp-server/src/proyecto.ts`, `src/herramientas-proyecto.ts`
- Modify: `src/index.ts`, `src/paths.ts:48-59`
- Test: `video-mcp-server/test/proyecto.test.ts`, `test/stdio.test.ts`

**Interfaces.** Carpeta `<VIDEO_ROOT>/<id>/`: `proyecto.json`, `voz/`, `recursos/`, `_composicion/`, `_render/`, `video.mp4`. El MP4 pasa **dentro** de la carpeta: si no, borrar un proyecto lo dejaría huérfano. Guiones: `<estado>/video/guiones/<g-16hex>.json`, con base en `path.dirname(VIDEO_ROOT)`.

| Tool | Argumentos | Devuelve en `datos` |
|---|---|---|
| `video_guion_esquema` | — | `{ texto }` |
| `video_guion_guardar` | `{ guion, id? }` | `{ id, avisos }` |
| `video_guion_listar` / `leer` / `borrar` | `{}` / `{ id }` / `{ id }` | lista / guion / `{}` |
| `video_proyecto_crear` | `{ guionId, perfilId }` | `{ id }` (copia de una vía, D6b) |
| `video_proyecto_listar` / `leer` | `{}` / `{ id }` | resumen / proyecto con `avisos` |
| `video_proyecto_guardar` | `{ id, revision, proyecto }` | `{ revision, avisos }` |

Los errores tipados salen como `isError` con un bloque JSON `{ codigo: "esquema"|"conflicto"|"no_encontrado", problemas }`.

**En integrado no se registran:** `video_guardar_guion`, `video_generar_voz` antigua, `video_estado`, `video_listar` y `video_musica` (que admite `musica:` como ruta).

**Seguridad.** I1, I6, I10. Validación al leer y al escribir. Escritura atómica (`escribirAtomico`). `recursos` no lo cambia el cliente: `guardar` exige que coincida con el disco, para que un PUT no pueda referenciar un fichero que no pasó por la importación.
**Negativas:** `proyecto_en_disco_malo` (`"color": "red;background:url(//x)"`, fuente fuera de lista: rechazado al cargar). `recursos_del_cliente_rechazados`. `id_invalido` (`..\\x`, `video1`, `CON`). `sin_tools_antiguas_en_integrado` (`listTools` con `VIDEO_ENGINE_EMBEDDED=1`).

- [ ] **Step 1: Tests que fallan.** Las negativas, más `crear_copia_una_via` (editar el guion no toca el proyecto), `revision_antigua_409` (`codigo: "conflicto"`) y `escritura_atomica` (fallo a mitad: el fichero anterior intacto).
- [ ] **Step 2: Ejecutar.** Esperado: FAIL.
- [ ] **Step 3: Implementar.** Reutilizar `validarId`, `siguienteId`, `resolverDentro`. Ajustar `archivosVideo.mp4`.
- [ ] **Step 4: Ejecutar.** Esperado: PASS.
- [ ] **Step 5: Commit.** `Motor: almacén de guiones y proyectos validado al cargar (SEO-xx)`

### Task 5: Voz por frases

**Files:**
- Create: `video-mcp-server/src/voz.ts`
- Modify: `src/tts.ts`, `src/herramientas-proyecto.ts`, `src/proceso.ts:844` (lista de demuxers)
- Test: `video-mcp-server/test/voz.test.ts`, `test/tts.test.ts`

**Interfaces.**
- `video_voz_coste { id }` → `{ pendientes: fraseId[], caracteres, voz }`.
- `video_voz_generar { id, frases?, caracteresConfirmados }` → `{ generadas, caracteresFacturados, fallo? }`.
- `video_voz_forma { id }` → `{ picos: number[], segundos }`.
- `video_voz_quitar_silencios { id, fraseId }` → `{ recorte }`.
- `video_voces {}` → `{ voces: [{ id, nombre, idioma }] }`.
- `video_voz_muestra { voiceId, caracteresConfirmados }` (M-D3).
- Fichero por frase, **direccionado por contenido**: `voz/<sha256(voiceId|modelo|texto)>.mp3` y `.json`, escribiendo primero el mp3 y renombrando el json al final. La frase existe si está el json.
- `ensamblarVoz(p): Promise<string>`: lista generada para el demuxer `concat` con `inpoint`/`outpoint`, a `voz/ensamblada-<hash>.wav`.
- `silencios`: huecos > 0,25 s entre palabras de la alineación, sin `silencedetect`, que no está en el build.

**Seguridad.** I5, I10, I15 y D7.
- El gasto exige `caracteresConfirmados` igual al cálculo del servidor; si no, `codigo: "coste_cambiado"`. Así un cambio entre mostrar y confirmar no se factura.
- `voiceId` con regex `^[A-Za-z0-9]{10,40}$` y `encodeURIComponent` en la URL.
- Respuesta acotada a 20 MB, y audio ≤ 10 MB por frase, con `sondear` y lista blanca `mp3`. W3.4 deja el tope global en 64 MiB: aquí se aplica el de D7.
- La lista de `concat` la genera el motor solo con nombres hash y ruta relativa, y se abre con `-protocol_whitelist file` y `-format_whitelist concat,mp3`. El texto del guion nunca entra en ella.
- `VIDEO_PRUEBAS_TTS_URL` solo se acepta si empieza por `http://127.0.0.1:`, y el backend congelado nunca la pasa (T21 lo comprueba).
**Negativas:** `alineacion_nan_no_guarda`, `retrocede_no_guarda`, `diez_a_la_seis_caracteres`, `audio_grande_rechazado`, `no_mp3_rechazado`, `clave_fuera_de_error` (401 con la clave en el cuerpo), `coste_cambiado_no_llama` (el `fetch` simulado cuenta 0 llamadas).

- [ ] **Step 1: Tests que fallan.** Las negativas, más CA3: `una_frase_factura_una` (cambiar una de 12 frases: 1 llamada y solo sus caracteres), `reintento_no_refactura` (fallo 429 en la frase 7: 6 conservadas, y el reintento llama solo por las restantes), `misma_frase_reutiliza` y `reordenar_no_regenera`.
- [ ] **Step 2: Ejecutar.** Esperado: FAIL.
- [ ] **Step 3: Implementar.** Generación en serie, para no chocar con el límite de concurrencia. `sintetizarConTimestamps` recibe `voiceId` por argumento y lee `baseElevenLabs(env)`. `procesarAlineacion` por frase, con `validarPalabras`. La forma de onda sale de `ffmpeg … -f wav -ac 1 -ar 8000 pipe:1` y se reduce en Node a ≤ 2000 picos.
- [ ] **Step 4: Ejecutar.** Esperado: PASS.
- [ ] **Step 5: Commit.** `Motor: voz por frases con coste confirmado (SEO-xx)`

### Task 6: Montaje de preview y de render

**Files:**
- Modify: `video-mcp-server/src/render.ts:231-374,614-670`, `src/herramientas-proyecto.ts`, `src/index.ts:88-98`
- Test: `video-mcp-server/test/montaje.test.ts`, `test/render-modos.test.ts`

**Interfaces.**
- `video_montar_preview { id, webgpu: boolean }` → `{ carpeta: "r<n>", duracion, avisos, fondo: { pedido, usado } }`. Escribe en `_composicion/r<n>/` y borra las anteriores salvo la última.
- `video_renderizar { id, modo: "auto"|"rapido"|"compatible" }`: exponer `modo` en la tool. Compone en `_render/<job>/`, nunca en `_composicion/`, y borra esa carpeta al acabar.
- `Job.fondo` y `video_estado_render` lo devuelven. El MP4 no sale como ruta absoluta en integrado.
- `prepararProyecto(id, o): Promise<Preparado>` sustituye a `prepararRender` en integrado. Audio normalizado en caché por hash, para que un cambio de texto no repita `loudnorm`.

**Reglas fijadas:**
- Faltan voces → `codigo: "voz_pendiente"` con la lista. Recurso pendiente → aviso, no bloqueo: la base se ve.
- **Aviso de degradación (W2.2, I11):** si `opciones.fondo` pide WebGPU y `hayWebgpu` da `false`, entonces `job.reserva = "Fondo <x> sustituido por el degradado CSS"` y `fondo.usado = "css"`. Nunca en silencio, tampoco por GPU ocupada.
- Preview: `gpu` lo decide la UI con `navigator.gpu?.requestAdapter()`, porque WebView2 y CfT pueden diferir. Si difieren, aviso.

**Seguridad.** I2, I7, I11, I13. La carpeta `r<n>` sale de un contador del motor, nunca de la UI. El render sigue pasando por `comprobarComposicion` con `ok: true` obligatorio.
**Negativas:** `render_no_pisa_preview` (preview montada durante un render: `_render/` intacto). `fondo_degradado_visible` (`VIDEO_FORZAR_SIN_GPU=1`: `reserva` no vacío). `modo_invalido`. `clave_en_composicion` (barrido de `_composicion` y `_render`). `timeout_sin_procesos` sigue pasando con `_render/`.

- [ ] **Step 1: Tests que fallan.** Las negativas, más `edicion_texto_no_normaliza` (espía de `ejecutar`: 0 llamadas a `loudnorm`), `montaje_edicion_rapido` (< 1 s sin ffmpeg), `voz_pendiente_lista` y `modo_llega_a_job`.
- [ ] **Step 2: Ejecutar.** Esperado: FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Ejecutar** los tests y `npm run render:mock`. Esperado: PASS.
- [ ] **Step 5: Commit.** `Motor: preview y render en carpetas separadas, con reserva visible (SEO-xx)`

### Task 7: Recursos normalizados y capas

**Files:**
- Create: `video-mcp-server/src/recursos.ts`, `plantilla/piezas/capa-foto.html`, `plantilla/piezas/capa-clip.html`
- Modify: `src/composicion.ts` (capas), `src/herramientas-proyecto.ts`
- Test: `video-mcp-server/test/recursos.test.ts`, `test/piezas-capas.test.ts`, `test/fixtures-medios/` (fixtures hostiles generados en el test)

**Interfaces.**
- `video_recurso_importar { id, bandejaId, clase: "foto"|"clip"|"musica" }` → `{ recurso, avisos }`.
- `video_recurso_borrar { id, recursoId }`. Si una escena lo usa: `codigo: "en_uso"`.
- `video_musica_listar {}` y `video_musica_importar { bandejaId }`.
- Bandeja: `<estado>/video/bandeja/<32hex>.bin`, consumida una vez.

Formatos canónicos, con el encoder disponible:
| Clase | Salida | Encoder |
|---|---|---|
| Foto | PNG, lado ≤ 3840 | `png` |
| Clip | MP4 H.264, sin audio, ≤ 60 fps | el mejor de `ordenSegundaPasada` (`h264_mf` como reserva), registrado |
| Música | M4A AAC (`-f mp4`) | `aac` |

Capa: `{ recursoId, modo: "encima"|"detras", encuadre: "marco"|"zoom"|"paneo", entrada, salida }`. `detras` solo sobre `ESCENAS_SOBRE_FONDO`. Horizontales según M-D7.

**Seguridad.** I6, I15. Identificación por bytes iniciales, nunca por extensión. Límites de I15 antes de decodificar: foto ≤ 50 MB, ≤ 8192 px, ≤ 40 Mpx; clip ≤ 500 MB, ≤ 60 s, ≤ 4096 px, ≤ 60 fps; música ≤ 100 MB, ≤ 15 min. `argsEntrada` con demuxer explícito, timeout y `ejecutar`. Copia con `copiarRecurso` (W3.4). `nombreOriginal` solo como texto de UI, recortado y con `textoSeguro`. HyperFrames, la preview y el análisis solo ven lo normalizado.
**`?hf-proxy`:** R1-W1.6b lo dejó «revisar cuando entren los clips». Se revisa aquí contra `serveProxyRequest` y se documenta en el informe. Test: `check_con_clip_sin_red`.
**Negativas (tabla de la spec):** `mp4_que_es_hls_o_concat` (nada del fichero referenciado sale), `png_20000`, `clip_2h`, `symlink_hardlink_junction_rechazados`, `bandeja_un_solo_uso`, `bandeja_id_invalido`, `extension_mentirosa`, `nombre_original_con_html` (escapado, nunca en la composición).

- [ ] **Step 1: Tests que fallan.** Las negativas, más `foto_pequena_avisa` (D9, < 1080×1920), `recurso_en_uso`, `capa_foto_seek_y_render` y `capa_clip_seek_y_render` (SSIM ≥ 0,99 entre seek y render por `scripts/comparar-fotogramas.mjs`).
- [ ] **Step 2: Ejecutar.** Esperado: FAIL.
- [ ] **Step 3: Implementar.** Las piezas usan `HF.contexto`, nunca leen tiempos del DOM y no llevan `innerHTML`. Ambas pasan `hyperframes check`.
- [ ] **Step 4: Ejecutar.** Esperado: PASS.
- [ ] **Step 5: Commit.** `Motor: recursos normalizados y capas de foto y clip (SEO-xx)`

### Task 8: Perfil visual mínimo

**Files:**
- Create: `video-mcp-server/src/perfil.ts`
- Modify: `src/herramientas-proyecto.ts`
- Test: `video-mcp-server/test/perfil.test.ts`, `test/generico.test.ts`

**Interfaces.** `Perfil = { id, nombre, voz, idioma, colores: { fondo, texto, acento, contorno, secundario }, fuente: "Anton"|"Inter Tight"|"JetBrains Mono" }`, en `<estado>/video/perfiles/<id>.json`. `temaDePerfil(p): Tema` pasa por `validarTema`. Tools `video_perfiles_listar`, `video_perfil_guardar`, `video_perfil_duplicar`.

**Seguridad.** I1 y G1. Validación al cargar: el `color()` silencioso ya no aplica, porque W3.1 lo convierte en rechazo. El perfil por defecto es neutro.
**Negativas:** `perfil_color_css_rechazado`, `perfil_fuente_fuera_de_lista`, `perfil_con_campo_de_mas`, `perfil_id_recorrido`. `sin_futbol` en `generico.test.ts`, ampliado a prompts, descripción del esquema y perfil por defecto.

- [ ] **Step 1: Tests que fallan.** Las negativas, más `dos_perfiles_dos_temas` (mismo guion con dos perfiles: CSS distinto, sin tocar nada más).
- [ ] **Step 2: Ejecutar.** Esperado: FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Ejecutar.** Esperado: PASS.
- [ ] **Step 5: Commit.** `Motor: perfil visual mínimo validado al cargar (SEO-xx)`

---

## Carril B · Backend

### Task 9: Frontera REST del guion

> **Esta es la primera ruta por la que la salida del modelo llega a la composición.** Hasta hoy, la R2 aceptó residuales porque «ninguna entrada no confiable llega a la composición». T9 rompe esa premisa. No se integra sin R1 conjunta con T1 y T3.

**Files:**
- Create: `app-backend/app_backend/video_rest.py`
- Modify: `app-backend/app_backend/main.py`, `app_backend/video.py:190-205`
- Test: `app-backend/tests/test_video_rest.py`, `tests/test_registry.py`, `tests/motor_falso.py`

**Tabla REST** (todas con bearer; rutas de esta tarea en negrita, las demás en T10 y T11):

| Método y ruta | Cuerpo | Respuesta | Errores |
|---|---|---|---|
| **GET** `/video/guiones/esquema` | — | `{ texto }` | 503 |
| **GET** `/video/guiones` · **POST** `/video/guiones` | `{ guion }` | lista · 201 `{ id, avisos }` | 413, 422 |
| **GET** · **DELETE** `/video/guiones/{gid}` | — | guion · `{}` | 404 |
| **GET** `/video/proyectos` · **POST** | `{ guion_id, perfil_id }` | lista con estado · 201 `{ id }` | 404, 422 |
| **GET** · **PUT** · **DELETE** `/video/proyectos/{id}` | PUT: `{ revision, proyecto }` | proyecto · `{ revision, avisos }` · `{}` | 404, 409, 413, 422 |
| POST `/video/proyectos/{id}/preview` · DELETE | `{ webgpu }` | `{ url, duracion, avisos, fondo }` · `{}` | 409, 503 |
| GET `/video/proyectos/{id}/voz/coste`, `/voz/forma` | — | ver T5 | 404 |
| POST `/video/proyectos/{id}/voz`, `/voz/quitar-silencios` | `{ frases?, caracteres_confirmados }` | ver T5 | 409, 502 |
| POST `/video/proyectos/{id}/recursos` · DELETE `/recursos/{rid}` | `{ bandeja_id, clase }` | ver T7 | 409, 413, 422 |
| POST `/video/proyectos/{id}/render` | `{ modo }` | 202 job | 409, 422 |
| GET `/video/perfiles` · POST `/video/perfiles/{pid}/duplicar` · PUT `/video/perfiles/{pid}` | perfil | ver T8 | 422 |
| GET `/video/voces` · POST `/video/voces/muestra` · GET · POST `/video/musica` | — | ver T5 y T7 | 409 |

**Interfaces.**
- `crear_router(estado, protegido) -> APIRouter`, montado en `create_app`.
- Patrones de ruta: `id` `^video\d{3}$`, `gid` `^g-[0-9a-f]{16}$`.
- `MotorError` gana `codigo: str | None` y `problemas: list`. `_respuesta` los lee del bloque JSON de T4. Mapa: `esquema` → 422, `conflicto` → 409, `no_encontrado` → 404, `coste_cambiado` → 409. `MotorNoDisponible` → 503.
- `LimiteCuerpo`: middleware ASGI puro para `/video/`, con **1 MiB** contando el flujo real, no solo `Content-Length`. Puro, porque `BaseHTTPMiddleware` interfiere con el SSE del chat.

**Modelo de amenazas de la frontera.** Atacante A1: controla el JSON vía KB, transcripción, datos del canal o guion pegado.

| Qué intenta | Control | Prueba negativa |
|---|---|---|
| Ejecutar JS en la composición (render o preview) | Esquema estricto; escape por contexto; ids por índice; sin HTML del modelo | `xss_en_cada_campo`: POST real → `_composicion/**` sin `<script>` del atacante (T3 + T9 con motor real) |
| Leer o escribir ficheros por una ruta | Sin campos de ruta; recursos por id de servidor; `extra="forbid"` | `ruta_en_cuerpo_422`, `musica_ruta_rechazada`, `recurso_inexistente_422` |
| Sacar datos por red | CSP, proxy nulo, `urlsDeRed` | `url_en_texto_inerte` y sondas de `csp-integracion` con el flujo nuevo |
| Gastar dinero o renderizar sin el usuario | Ninguna tool ni job del modelo; coste confirmado | `test_registry_sin_tools_video`, `jobs_rechaza_video_render`, `modelo_no_llega_a_rutas`: un turno con tool `video_*` inventada da «tool desconocida» |
| Colgar o tumbar el sidecar | Tope de cuerpo; profundidad ≤ 16 antes de reenviar; timeouts por llamada | `cuerpo_2mib_413` (también sin `Content-Length`), `json_anidado_422`, `motor_cuelga_503_y_sigue` |
| Disparar cuotas o CPU con 90 escenas | Límites del esquema | `limites_en_rest` |
| Meter datos por `__proto__` o claves raras | `.strict()`, arrays y no mapas | `proto_rechazado` |
| Filtrar secretos o rutas en errores | `problemas` sin valores; clave ocultada; sin rutas | `error_sin_centinela`, `error_sin_ruta`: `sinRutas` no cambia nada |
| Saltarse el bearer o reutilizar la API desde una web | Bearer + CORS exacto | `todas_las_rutas_exigen_bearer`: recorre `app.routes` y falla con cualquier ruta nueva sin él, salvo lista vacía. La preview va en otra app |
| Abrir documentos sin CSP en el puerto de la API | `docs_url=None`, `redoc_url=None`, `openapi_url=None`; cabecera `Content-Security-Policy: sandbox; default-src 'none'` en toda respuesta (ASGI puro) | `sin_docs`, `respuesta_con_csp`, y SSE del chat sin cambios |
| Editar desde otra fuente con esquema viejo | Validación al cargar; `revision` | `proyecto_manipulado_422` |
| Borrar fuera del proyecto | Borrado solo en backend; hija directa; punto de reanálisis rechazado; no sigue enlaces (D6b) | `junction_interna_centinela_intacta`, `id_recorrido_404`, `carpeta_reanalisis_rechazada` |

**Precondiciones que el revisor comprueba, no que este plan da por hechas:** M-1 (bypass solo al puerto), `check` con `ok:false` como fallo, render en Untrusted, W3.1 T1–T2, W3.4 T4, `VIDEO_ENGINE` apagada.

- [ ] **Step 1: Escribir los tests de la tabla, que fallan.** Los de esquema contra el motor real por `APP_BACKEND_VIDEO_CMD`; el resto contra `motor_falso.py`, ampliado con esas tools.
- [ ] **Step 2: Ejecutar.** `uv run --extra dev pytest -q tests/test_video_rest.py`. Esperado: FAIL.
- [ ] **Step 3: Implementar** `crear_router`, `LimiteCuerpo` y la cabecera, y desactivar los documentos.
- [ ] **Step 4: Borrado.** `borrar_proyecto(id)` en `video_rest.py`: `Path` con `id` validado, `parent == VIDEO_ROOT`, `navegador.es_enlace` en la carpeta y `_borrar` sin seguir enlaces. Reutilizar `navegador._borrar`, que ya desenlaza.
- [ ] **Step 5: Ejecutar** `pytest -q`. Esperado: PASS.
- [ ] **Step 6: Commit.** `Backend: frontera REST de guiones y proyectos (SEO-xx)`
- [ ] **Step 7: Puerta.** R1 conjunta de T1, T3 y T9. Sin Critical ni High abiertos, no sigue.

### Task 10: Preview por capacidad

**Files:**
- Create: `app-backend/app_backend/preview.py`
- Modify: `app-backend/app_backend/main.py:668-682`, `app_backend/video_rest.py`, `app_backend/config.py`
- Test: `app-backend/tests/test_preview.py`, `video-mcp-server/scripts/sondear-preview.mjs`, `test/piezas-w24.test.ts`

**Interfaces.**
- `PUERTOS_PREVIEW = (47810, 47811, 47812, 47813)` en `config.py`. Test: coincide con `frame-src` de `tauri.conf.json`.
- `class Claves: abrir(id, carpeta) -> str; rotar(id, carpeta); cerrar(id); buscar(clave) -> Entrada | None`. Solo en memoria, una por proyecto, `secrets.token_urlsafe(32)`, comparación con `compare_digest` recorriendo todas.
- `crear_app(claves, puerto) -> FastAPI`: **app aparte, una sola ruta** `GET|HEAD /p/{clave}/{ruta:path}`, sin documentos ni bearer.
- `main()`: `uvicorn.Server(Config(despachar(api, preview), log_level="info", access_log=False)).run(sockets=[api, preview])`. `despachar` es ASGI puro y elige por `scope["server"][1]`. Sin puerto libre: la API arranca igual y `POST preview` da 503 legible.
- Runtime: `<VIDEO_ENGINE_DIR>/app/node_modules/hyperframes/dist/hyperframe.runtime.iife.js`, SHA-256 fijado en `config.py` y comprobado al abrir. Si no cuadra: 503, nunca servir otro (I4, I11).
- `CONTROL_JS` en `preview.py`, derivado del spike sin las órdenes de medición.
- Mensajes hacia dentro: `seek { id, t }`, `play`, `pause`. Hacia fuera: `listo { duracion }`, `seek-hecho { id, t }`, `tiempo { t, reproduciendo }` (≤ 30 por segundo), `error { id }` sin texto.
- `html` inyecta `<script src="__preview/runtime.js">` y `control.js` **justo después del `<meta>` de la CSP** (W1.2 M3) y reescribe `'self'` por el origen exacto en el `<meta>`.

**Seguridad.** I2, I4, I6, I8, A4.
- Cabeceras en **toda** respuesta de la ruta, incluidos 404 y 421: `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src http://127.0.0.1:<p> 'unsafe-inline'; style-src http://127.0.0.1:<p> 'unsafe-inline'; img-src http://127.0.0.1:<p> data: blob:; font-src http://127.0.0.1:<p> data:; media-src http://127.0.0.1:<p> blob:; connect-src http://127.0.0.1:<p>; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors http://tauri.localhost https://tauri.localhost http://localhost:1420`, más `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.
- **CORS del túnel y de las subcomposiciones:** `Access-Control-Allow-Origin: null` y `Vary: Origin`, solo si la petición trae `Origin: null` y la clave es válida. Nunca `*` (L12). Sin credenciales ni `OPTIONS`. Se activa el `it.skip` de `piezas-w24` y `sondear-preview.mjs` deja de enviar `*`.
- Rutas: `Host` exacto o 421; solo GET y HEAD; segmentos sin `..`, `:`, `\`, NUL ni nombres reservados; `es_enlace` en cada segmento bajo `_composicion/r<n>/`; lista blanca de extensiones y `Content-Type` por extensión. Clave atada a su carpeta `r<n>`: nunca `recursos/`, `voz/` ni el proyecto.
- Clave: fuera de logs (`access_log=False`), invalidada al cerrar el editor, al borrar y al reiniciar.

**Negativas:** `clave_mala_404_con_csp`, `clave_cerrada_404`, `clave_de_otro_proyecto`, `recorrido_y_codificado` (`..%2f`, `%5c`, `C:/x`, `::$DATA`, `CON`), `junction_dentro_rechazada`, `fuera_de_composicion_404` (`proyecto.json`, `voz/`), `extension_fuera_de_lista`, `host_rebinding_421`, `post_405`, `sin_estrella_en_cors`, `origen_web_sin_cors`, `runtime_alterado_503`, `clave_no_en_logs` (centinela: `caplog` y stderr), `api_no_responde_en_puerto_preview` y al revés, `reiniciar_invalida`.

- [ ] **Step 1: Tests que fallan.**
- [ ] **Step 2: Ejecutar.** Esperado: FAIL.
- [ ] **Step 3: Implementar.** `POST …/preview`: llama a `video_montar_preview`, abre o rota la clave y devuelve `{ url: "http://127.0.0.1:<p>/p/<clave>/index.html", … }`. Sin `src` armado en la UI (I8).
- [ ] **Step 4: Ejecutar** `pytest -q` y `npx vitest run test/piezas-w24.test.ts`. Esperado: PASS, con WebGL del túnel sin «cross-origin data» y el `it.skip` retirado.
- [ ] **Step 5: Commit.** `Backend: preview por capacidad en origen propio (SEO-xx)`

### Task 11: Voz, recursos, perfiles y render por REST

**Files:**
- Modify: `app-backend/app_backend/video_rest.py`, `app_backend/jobs.py`, `app_backend/main.py:108-111,267-272`, `app_backend/video.py:54,336-376`, `app_backend/agent.py` (`SYSTEM_PROMPT`)
- Test: `app-backend/tests/test_video_rest.py`, `tests/test_jobs.py`, `tests/test_agent.py`

**Interfaces.**
- `Jobs(path, runners, carriles={"video_render": "video"}, internos={"video_render"})`: un worker por carril. Un render no bloquea subidas ni transcripción. `POST /jobs` rechaza los internos con 400, y `enqueue(..., interno=True)` solo lo usa la ruta de render.
- Runner `render_job(id, titulo, modo)`: lanza `video_renderizar` y sondea `video_estado_render` cada segundo con `asyncio.run_coroutine_threadsafe`. Progreso = `progreso / 100`. El resultado solo lleva `{ id, duracion, modo, codificador, avisos, reserva }`, sin rutas.
- `Cerrojos`: `dict[id, "render"|"voz"]` en memoria. Es en backend porque hay dos procesos de motor. `GET /video/proyectos` deriva `estado`: `renderizando` por cerrojo, `listo` si existe el MP4, `error` si el último job falló, y `borrador` en otro caso.

**Reglas de 409 (L-4):** voz con render activo; render con voz activa; borrar proyecto con render activo; borrar recurso en uso. PUT sigue permitido durante un render, porque compone en `_render/`.

**Seguridad.** I5, I7, I10, CA6, CA7. La clave nunca en respuestas ni en `args` del job. El canal de render sigue sin clave.
**Negativas:** `render_colgado_falla_y_cola_sigue` (motor falso que no acaba; deadline: job `failed`, legible, y un upload posterior corre), `motor_muere_en_render`, `voz_con_render_409`, `render_con_voz_409`, `borrar_con_render_409`, `borrar_invalida_clave`, `recurso_en_uso_409`, `jobs_rechaza_video_render`, `clave_no_en_jobs`, `resultado_sin_rutas`, `coste_cambiado_409`, `sin_clave_elevenlabs_409`.

- [ ] **Step 1: Tests que fallan.**
- [ ] **Step 2: Ejecutar.** Esperado: FAIL.
- [ ] **Step 3: Implementar.** `TOOLS_CANAL_RENDER` pierde `video_estado`, que ya no existe en integrado. Timeout de `video_voz_generar`: `60 + 200 × frases` s, para no matar el motor a media ejecución. Deadline del runner: 6 h, sobre el peor caso de 180 s. `entorno_motor` reenvía `VIDEO_PRUEBAS_TTS_URL` solo si `not config.FROZEN`. `SYSTEM_PROMPT` añade: sin material con derechos de retransmisión como recurso sugerido, y escenas generadas cuando no haya recurso (D5). Test: `prompt_con_reglas_de_video`.
- [ ] **Step 4: Ejecutar** `pytest -q`. Esperado: PASS.
- [ ] **Step 5: Commit.** `Backend: voz, recursos y render con cerrojo por proyecto (SEO-xx)`

---

## Carril R · Rust

### Task 12: CSP de la preview, WebRTC e instancia única

**Files:**
- Modify: `app-ui/src-tauri/tauri.conf.json`, `app-ui/src-tauri/src/lib.rs`, `app-ui/src-tauri/Cargo.toml` (según M-D4)
- Test: `app-backend/tests/test_preview.py` (lee el JSON), `#[cfg(test)]` en `lib.rs`

**Cambios fijados:**
- `csp` y `devCsp`: añadir `frame-src http://127.0.0.1:47810 http://127.0.0.1:47811 http://127.0.0.1:47812 http://127.0.0.1:47813`. `devCsp` pierde `127.0.0.1:*` en `frame-src`; si W3.5 no se ha integrado, el spike usa un puerto de esa lista.
- `app.windows[0].additionalBrowserArgs`: `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --force-webrtc-ip-handling-policy=disable_non_proxied_udp`. Al fijarlo, Tauri deja de poner sus valores por defecto, así que van explícitos.
- Instancia única según M-D4. Debe enfocar o cerrar antes de lanzar el sidecar.

**Seguridad.** I8 y M-4. El test falla con cualquier `*` en `frame-src`, o si `connect-src` y `frame-src` admiten otro host. `capabilities/default.json` sigue con `core:default` solo.
**Negativas:** `frame_src_sin_comodin`, `puertos_coinciden`, `capacidades_sin_cambios`. La sonda de navegación de `csp-integracion` con marco que lista 4 puertos: navegar a un quinto se bloquea. WebRTC en WebView2: comprobación manual de Marc, porque Playwright no aplica estos argumentos.

- [ ] **Step 1: Tests que fallan.**
- [ ] **Step 2: Implementar.**
- [ ] **Step 3: Verificar.** `cargo test --manifest-path app-ui/src-tauri/Cargo.toml` y `pytest -q tests/test_preview.py`. Esperado: PASS. `pnpm tauri dev` desde Git Bash abre y sin violaciones en consola.
- [ ] **Step 4: Commit.** `Tauri: frame-src por puertos exactos y WebRTC cerrado (SEO-xx)`

### Task 13: Comandos de importar y exportar

**Files:**
- Modify: `app-ui/src-tauri/src/lib.rs`, `app-ui/src-tauri/Cargo.toml` (feature `Win32_Storage_FileSystem` de `windows-sys`)

**Interfaces.**
- `importar_recurso(app, clase: String) -> Result<Option<String>, String>`: diálogo con filtro por clase, copia a la bandeja y devuelve 32 hex.
- `exportar_mp4(app, id: String) -> Result<Option<()>, String>`: diálogo de guardar. Copia `<estado>/video/proyectos/<id>/video.mp4` al destino.
- `fn dir_estado() -> PathBuf`: `APP_BACKEND_DIR` o `%LOCALAPPDATA%\seo-studio`, igual que `config.py`. Test cruzado por literal.

**Seguridad.** I6. Se abre **una vez** con `FILE_FLAG_OPEN_REPARSE_POINT`. Sobre el handle: `GetFileInformationByHandle` exige fichero normal, `nNumberOfLinks == 1`, sin `REPARSE_POINT`, y tamaño ≤ límite de clase (50, 500, 100 MB). Copia desde ese handle con `take(limite + 1)`. Destino con `create_new(true)`. `id` por regex `^video\d{3}$` y `clase` de lista cerrada. Ruta absoluta nunca devuelta a la UI ni registrada.
**Negativas** (funciones puras separadas del diálogo, con `#[cfg(test)]`): `rechaza_symlink`, `rechaza_hardlink`, `rechaza_junction`, `rechaza_grande`, `id_invalido`, `clase_invalida`, `destino_no_se_pisa`.

- [ ] **Step 1: Tests que fallan.**
- [ ] **Step 2: Implementar** `copiar_a_bandeja(origen, dir, limite) -> Result<String, String>` y los comandos. Actualizar la cabecera de `lib.rs`.
- [ ] **Step 3: Verificar.** `cargo test`. Esperado: PASS.
- [ ] **Step 4: Commit.** `Tauri: importar y exportar por handle único (SEO-xx)`

---

## Carril U · UI

Fuera de Tauri los dos comandos no existen. Los E2E siembran la bandeja desde `global-setup`. No hay `input file` de reserva. Los E2E con motor real necesitan ffmpeg: en el job de CI se decide en T21 si se instala, sin saltarlos en silencio.

### Task 14: Contrato de pantallas, cliente y modelo

**Files:**
- Modify: `app-ui/docs/pantallas.md`, `src/api/client.ts`, `src/api/types.ts`, `src/api/queries.ts`, `src/App.tsx`, `src/shell/Sidebar.tsx`, `src/CommandPalette.tsx`
- Create: `src/video/modelo.ts`, `src/state/editor.ts`, `e2e/video-comun.ts`, `e2e/elevenlabs-mock.ts`. Esqueletos que exportan un componente vacío, para que U2–U5 compilen sin tocarse: `src/screens/VideoScreen.tsx`, `src/screens/EditorVideoScreen.tsx`, `src/video/Preview.tsx`, `src/video/panel/Panel.tsx`, `src/video/timeline/Timeline.tsx`, `src/video/render/RenderBoton.tsx`
- Modify: `e2e/global-setup.ts`: compila el motor, usa el **motor real** por `APP_BACKEND_VIDEO_CMD`, levanta `elevenlabs-mock` y exporta `VIDEO_PRUEBAS_TTS_URL`
- Test: `src/test/editor.test.ts`, `src/test/client.test.ts`

**Contrato** (se escribe entero aquí para que U1–U5 no compartan `pantallas.md`):

- **Marco:** `nav-video` («Vídeo», entre Guiones y Canal). Paleta: «Abrir Vídeo».
- **Lista `/video`:** `video-lista`, `video-proyecto-<id>` (título, perfil, duración, fecha), `video-proyecto-estado-<id>` (`data-estado` = `borrador|renderizando|listo|error`), `video-proyecto-borrar-<id>` (con confirmación), `video-vacio`, `video-sin-motor`, `video-error`.
- **Guiones:** `escribir-formato` gana la opción Vídeo; `escribir-video-nota`, `escribir-video-sin-motor`, `guion-video`, `guion-video-titulo`, `guion-video-gancho`, `guion-video-escenas`, `guion-video-escena` (`li`), `guion-video-frase`, `guion-video-tipo`, `guion-video-subir`, `guion-video-bajar`, `guion-video-recurso`, `guion-video-avisos`, `guion-video-errores` (`role=alert`), `guion-video-guardar`, `guion-video-crear`, `guiones-guardados`, `guion-guardado-<id>`, `guion-guardado-borrar-<id>`.
- **Editor `/video/:id`, layout B:** cabecera de 48 px; cuerpo `minmax(0, 1fr) 320px`; timeline a todo el ancho, 240 px, por debajo. Debe caber a 900×600. `editor`, `editor-titulo`, `editor-volver`, `editor-guardado` («Guardado», «Guardando…», «Error al guardar»), `editor-conflicto`, `editor-deshacer`, `editor-rehacer`, `editor-render`, `editor-error`.
- **Preview:** `preview-marco` (iframe 1080×1920 escalado con `transform`), `preview-play`, `preview-tiempo`, `preview-cargando`, `preview-error`, `preview-aviso-fondo`.
- **Panel:** `panel-pestanas`, `panel-escena`, `panel-recursos`, `panel-perfil`. Escena: `escena-vacia`, `escena-tipo`, `escena-campo-<campo>`, `escena-frase-<fraseId>`, `escena-capa-modo`, `escena-capa-encuadre`, `escena-capa-quitar`. Recursos: `recursos-aviso`, `recursos-anadir-foto`, `recursos-anadir-clip`, `recursos-lista`, `recurso-<id>`, `recurso-aviso-<id>`, `recurso-borrar-<id>`, `recursos-pendientes`, `recurso-pendiente-<escenaId>`, `recursos-error`. Perfil: `perfil-selector`, `perfil-duplicar`, `perfil-color-<campo>`, `perfil-fuente`, `perfil-voz`, `perfil-voz-escuchar`, `perfil-error`.
- **Timeline:** `timeline`, `timeline-regla`, `timeline-cabezal`, `pista-escenas`, `pista-recursos`, `pista-voz`, `pista-musica`, `pista-subtitulos`, `clip-escena-<id>`, `clip-recurso-<escenaId>`, `clip-voz-<fraseId>`, `clip-subtitulo-<i>`, `voz-generar`, `voz-coste`, `voz-regenerar-<fraseId>`, `voz-quitar-silencios-<fraseId>`, `voz-sin-clave`, `voz-confirmar`, `voz-confirmar-coste`, `voz-confirmar-ok`, `musica-elegir`, `musica-inicio`, `musica-volumen`, `musica-ducking`, `subtitulo-texto`.
- **Render:** `render-dialogo`, `render-bloqueo`, `render-lanzar`, `render-progreso`, `render-resultado`, `render-avisos`, `render-exportar`, `render-error`.
- **Ajustes › Motor de vídeo:** `ajustes-eleven-estado`, `ajustes-eleven-clave` (password, vacío siempre), `ajustes-eleven-guardar`, `ajustes-eleven-borrar`. **Se retira** `ajustes-render-modo-nota`.

**Interfaces.**
- `src/video/modelo.ts`: tipos espejo de `Proyecto` y `GuionVideo`, sin validación propia, porque el motor es la autoridad. `aGuionVideo(j): GuionVideoUi | null` reduce a cadenas y números, como `aGuion`.
- `src/state/editor.ts`: `useEditor` con `{ proyecto, revision, guardado, historial, futuro, seleccion, tiempo }`; `editar(fn)`, `deshacer()`, `rehacer()`. Historial ≤ 100 instantáneas del JSON (ponytail: snapshots; pasar a parches si pesa). Autoguardado con 800 ms de espera.

**Seguridad.** I6, I8. `Client` no tiene ningún método que reciba ruta, y un test lo comprueba sobre `types.ts`. El `src` del iframe solo sale de `url` del backend.

- [ ] **Step 1: Tests que fallan.** `deshacer_y_rehacer`, `autoguardado_agrupa`, `conflicto_recarga_sin_perder` (409: conserva la edición local como borrador y lo avisa), `url_preview_solo_loopback` (`aPreviewUrl` rechaza lo que no sea `http://127.0.0.1:4781[0-3]/p/`), `sin_rutas_en_cliente`.
- [ ] **Step 2: Ejecutar.** Esperado: FAIL.
- [ ] **Step 3: Implementar** contrato, cliente, store y rutas `/video` y `/video/:id`. `video-comun.ts` con fixtures de proyecto. `e2e/marco.spec.ts` y `visual.spec.ts` solo si cambia el orden del menú.
- [ ] **Step 4: Ejecutar** `pnpm test` y `pnpm e2e e2e/marco.spec.ts`. Esperado: PASS.
- [ ] **Step 5: Commit.** `UI: contrato, cliente y estado del editor de vídeo (SEO-xx)`

### Task 15: Guiones en modo Vídeo

**Files:**
- Modify: `app-ui/src/guiones/Escribir.tsx`, `src/guiones/comunes.tsx`, `src/guiones/modelo.ts`, `src/state/guiones.ts`, `src/guiones/Guiones.module.css`
- Create: `src/guiones/GuionVideo.tsx`, `e2e/video-guion.spec.ts`
- Test: `src/test/guiones.modelo.test.ts`, `src/test/guionesStore.test.ts`

**Interfaces.**
- `Formato = "long"|"short"|"video"`.
- `promptEscribirVideo(p, esquema: string)`: incluye `descripcionEsquema()`. Pide `buscar_kb`, KB privada y las tools de lectura del canal (mejores vídeos y retención). Texto del tema entre comillas como datos. «No ejecutes ninguna acción en YouTube». Responde solo JSON.
- `escribir-video-nota`: «Consulta tus vídeos y su retención: gasta cuota de YouTube, unas N unidades.» N = `youtube_retention_moments` × 3 vídeos, calculado de `GET /youtube/tools`.

**Flujo:** respuesta → `aGuionVideo` → edición (frases, tipo, orden) → `guion-video-guardar` = `POST /video/guiones` → errores del servidor en `guion-video-errores` → `guion-video-crear` = guardar + `POST /video/proyectos` + ir a `/video/:id`.

**Seguridad.** I1, I10. La UI no valida por el motor ni decide: todo pasa por T9. Nada se pinta como HTML. Crear exige clic del usuario, y ninguna URL o texto del modelo dispara la acción.
**Negativas (Vitest y E2E):** `html_del_modelo_es_texto` (`<img src=x onerror=…>`: sin nodo `img`), `json_invalido_no_pisa`, `sin_llamada_sin_clic` (0 POST al terminar el turno), `errores_servidor_como_texto`, `sin_motor_no_genera`.

- [ ] **Step 1: Tests que fallan.** Las negativas, más E2E: `guion_video_a_editor` (CA2, Anthropic falso con JSON de cocina y sidecar real) y `guardar_borrador_sin_proyecto`.
- [ ] **Step 2: Ejecutar.** Esperado: FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Ejecutar** `pnpm test` y `pnpm e2e e2e/video-guion.spec.ts e2e/guiones.spec.ts`. Esperado: PASS.
- [ ] **Step 5: Commit.** `Guiones: formato Vídeo con esquema del motor (SEO-xx)`

### Task 16: Lista de proyectos y marco del editor

**Files:**
- Modify: `app-ui/src/screens/VideoScreen.tsx`, `src/screens/EditorVideoScreen.tsx`
- Create: `src/screens/Video.module.css`, `src/video/Editor.tsx`, `src/video/Editor.module.css`, `e2e/video-editor.spec.ts`
- Test: `src/test/videoLista.test.tsx`

**Interfaces.** `Editor` monta el layout B y define las ranuras `<Preview />`, `<Panel />`, `<Timeline />` y `<RenderBoton />`. Ctrl+Z y Ctrl+Y fuera de campos de texto. Al salir: `DELETE …/preview`.

**Seguridad.** D6b: borrar con diálogo de confirmación, título como texto. I10: el modelo no alcanza estas acciones.
**Negativas:** `borrar_pide_confirmacion`, `titulo_html_es_texto`.

- [ ] **Step 1: Tests que fallan.** Más E2E: `lista_estados` (los 4 `data-estado`), `layout_b_900x600` (sin scroll horizontal, medidas exactas de las tres zonas) y `editor-conflicto`.
- [ ] **Step 2: Ejecutar.** Esperado: FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Ejecutar.** Esperado: PASS.
- [ ] **Step 5: Commit.** `UI: lista de proyectos y marco del editor (SEO-xx)`

### Task 17: Componente de preview

**Files:**
- Modify: `app-ui/src/video/Preview.tsx`
- Create: `src/video/Preview.module.css`, `src/video/previewProtocolo.ts`, `e2e/video-preview.spec.ts`
- Test: `src/test/previewProtocolo.test.ts`

**Interfaces.** `validarMensajeIframe(e: MessageEvent, ventana: Window, pendientes: Set<number>, duracion: number): MensajeIframe | null`, pura. Tras cada guardado con 400 ms de espera: `POST …/preview`, cambiar `src`, y al recibir `listo`, `seek` al tiempo anterior.

**Seguridad.** I8. Atributos **exactos**: `sandbox="allow-scripts"` y `allow="autoplay"`, sin `allow-same-origin`, `allow-popups` ni `allow-top-navigation`. Un mensaje solo se acepta con `e.source === iframe.contentWindow` y `e.origin === "null"`. Tipos de lista cerrada, `id` correlacionado y entero, números finitos y en `[0, duracion]`. Los demás se descartan en silencio y se cuentan. Más de 120 mensajes por segundo se ignoran. Nunca se pintan ni se usan como URL. `targetOrigin "*"` hacia dentro, porque el origen es opaco, y los mensajes no llevan datos sensibles.
**Negativas:** `source_ajeno`, `origen_no_null`, `tipo_desconocido`, `id_sin_pendiente`, `t_nan`, `t_fuera_de_rango`, `objeto_con_html`, `inundacion`. E2E real con sidecar y composición de fixture: `iframe_sin_token` (`window.parent` inaccesible, `localStorage` lanza, `__TAURI__` indefinido), `atributos_exactos`, `iframe_hostil_no_navega_padre` (fixture con `top.location`), `sonda_red_cero` (`fetch`, `WebSocket`, `img` externa).

- [ ] **Step 1: Tests que fallan.** Más E2E: `seek_pinta_fotograma`, `cambio_se_ve_sin_render` (CA4, parte 1) y `preview_error_visible` (503 de puerto ocupado).
- [ ] **Step 2: Ejecutar.** Esperado: FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Ejecutar.** Esperado: PASS.
- [ ] **Step 5: Commit.** `UI: preview aislada con protocolo validado (SEO-xx)`

### Task 18: Panel lateral

**Files:** Modify `app-ui/src/video/panel/Panel.tsx`. Create `panel/{PanelEscena,PanelRecursos,PanelPerfil}.tsx`, `panel/Panel.module.css`. Test: `src/test/panel.test.tsx`.

**Interfaces.** Solo escribe por `editar()` de T14. Formularios por `base.tipo` con los campos de T1. Música y fotos: `invoke("importar_recurso", { clase })` y luego `POST …/recursos`. Pendientes desde `escenas[].recursoPendiente`. Selector de voz con `GET /video/voces`.

**Seguridad.** I6, I15. La UI recibe `bandeja_id`, nunca ruta. `nombreOriginal` y `que_debe_salir` como texto. `recursos-aviso` con el texto de D9, siempre visible al añadir.
**Negativas:** `nombre_html_es_texto`, `error_sin_rutas` (`sinRutas`), `muestra_voz_pide_coste`.

- [ ] **Step 1: Tests que fallan.** Más `cambiar_tipo_conserva_frases`, `pendientes_senalados` y `perfil_cambia_y_preview_recarga`.
- [ ] **Step 2: Ejecutar.** Esperado: FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Ejecutar.** Esperado: PASS.
- [ ] **Step 5: Commit.** `UI: panel de escena, recursos y perfil (SEO-xx)`

### Task 19: Timeline de cinco pistas

**Files:** Modify `app-ui/src/video/timeline/Timeline.tsx`. Create `timeline/{PistaEscenas,PistaRecursos,PistaVoz,PistaMusica,PistaSubtitulos}.tsx`, `timeline/geometria.ts`, `timeline/Timeline.module.css`. Test: `src/test/timelineGeometria.test.ts`, `src/test/timeline.test.tsx`.

**Interfaces.** Implementación propia con Pointer Events, sin dependencia. `geometria.ts`, pura: `tiempoAX`, `xATiempo`, `reordenar(ids, desde, hasta)`, `ajustarAPalabra(t, palabras)`. Forma de onda en SVG desde `/voz/forma`. Música: pista de `GET /video/musica`, inicio, volumen y ducking.

**Reglas de coste:** `voz-generar` y `voz-regenerar-<fraseId>` abren `voz-confirmar` con los caracteres del servidor. El POST lleva `caracteres_confirmados`. Sin clave: `voz-sin-clave` con enlace a Ajustes.

**Seguridad.** I10: ningún gasto sin diálogo, tampoco al editar texto. Editar una frase solo la marca pendiente. Subtítulos como texto.
**Negativas:** `editar_no_llama_voz`, `coste_409_reabre`, `subtitulo_html_es_texto`.

- [ ] **Step 1: Tests que fallan.** Más `reordenar_escenas`, `recorte_ajusta_a_palabra`, `teclado_mueve_cabezal` (accesibilidad básica de las pistas). E2E en `video-editor.spec.ts`, con ElevenLabs simulado: `regenerar_una_frase` (CA3).
- [ ] **Step 2: Ejecutar.** Esperado: FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Ejecutar.** Esperado: PASS.
- [ ] **Step 5: Commit.** `UI: timeline de cinco pistas (SEO-xx)`

### Task 20: Render, exportar y clave de ElevenLabs

**Files:**
- Create: `app-ui/src/video/render/RenderDialogo.tsx`, `render/Render.module.css`, `e2e/video-render.spec.ts`
- Modify: `src/video/render/RenderBoton.tsx`, `src/screens/MotorVideo.tsx`, `src/screens/MotorVideo.module.css`, `src/state/renderModo.ts`, `e2e/motor-video.spec.ts`
- Test: `src/test/motorVideo.test.tsx`

**Interfaces.** `POST …/render { modo }`, con `modo` de `renderModo`. Progreso por `useJobs`: `nav-job` muestra `args.titulo`. `render-exportar` = `invoke("exportar_mp4", { id })`. Clave: `PUT /settings { elevenlabs_api_key }` tras `POST /settings/validate-elevenlabs-key`.

**Seguridad.** I5, I11. Campo password vacío siempre, sin mostrarla tras guardar. `render-avisos` pinta `reserva` y el codificador. Un fallo de render se ve, con `sinRutas`.
**Negativas:** `clave_nunca_en_dom`, `reserva_visible`, `error_sin_rutas`, `render_bloqueado_sin_voz` (`render-bloqueo`).

- [ ] **Step 1: Tests que fallan.** Más E2E: `render_hasta_resultado`, `render_fallido_legible` (CA6) y `nota_retirada` en `motor-video.spec.ts`.
- [ ] **Step 2: Ejecutar.** Esperado: FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Ejecutar.** Esperado: PASS.
- [ ] **Step 5: Commit.** `UI: render con modo, exportar y clave de ElevenLabs (SEO-xx)`

---

## Cierre

### Task 21: Aceptación de la fase 1

**Files:**
- Create: `video-mcp-server/test/fidelidad-preview.test.ts`, `test/aceptacion.test.ts`, `test/fixtures-guiones/{futbol,cocina}.json`, `test/rendimiento-180s.test.ts`
- Modify: `video-mcp-server/package.json` (script `render:aceptacion`, excluido de `npm test`), `app-backend/scripts/smoke_test.py`, `app-ui/e2e/visual.spec.ts` y capturas, `app-ui/docs/pantallas.md` («Regresión visual»), `.github/workflows/ci.yml` si Marc lo aprueba

**Interfaces.** `render:aceptacion`: motor real, ElevenLabs simulado, `h264_mf`.

| CA | Prueba |
|---|---|
| 1 | `dos_temas_dos_perfiles`: mismo build, dos MP4; `grep` sin literales de tema en `src/` y `plantilla/` |
| 2 | `guion_video_a_editor` (T15) |
| 3 | `una_frase_factura_una` (T5) y `regenerar_una_frase` (T19) |
| 4 | `cambio_se_ve_sin_render` (T17) y `fotogramas_fijos_ssim`: seek en la preview con CSP real frente al MP4, en 5 segundos fijos, SSIM ≥ 0,99, con fondo CSS. Con WebGPU en WebView2: M2 de Marc |
| 5 | `verificarMp4` con 1080×1920, 30 fps, duración y audio, y un MP4 sin audio falla |
| 6 | `render_colgado_falla_y_cola_sigue` (T11) y `render_fallido_legible` (T20) |
| 7 | `clave_ausente`: barrido de `video.log`, respuestas, `args` de tools y de jobs, composición y entornos de hijos |
| 8 | `sin_webgpu_y_sin_gpu`: `VIDEO_FORZAR_SIN_GPU=1` y sondeo vacío: `h264_mf`, reserva visible. Equipo real: Marc |
| 9 | Specs `video-*.spec.ts` y capturas `video` y `video-editor` en claro y oscuro, a 1200×800 y 900×600 |

**Smoke:** `VIDEO_PRUEBAS_TTS_URL` ausente del entorno del motor congelado, preview responde en su puerto con CSP, runtime con hash correcto, `/docs` da 404.

**Seguridad.** Repetir toda la tabla «Pruebas negativas mínimas» de la spec sobre la rama integrada, incluidas las que ya existen, y la R2 de punta a punta de las fronteras nuevas: UI → backend → motor → composición, y preview → padre.

- [ ] **Step 1: Escribir las pruebas.**
- [ ] **Step 2: Ejecutar** `npm test`, `npm run render:mock`, `npm run render:sandbox`, `npm run render:aceptacion`, `pytest -q`, `pnpm test`, `pnpm e2e` y `cargo test`. Esperado: todo PASS.
- [ ] **Step 3: Medir** `rendimiento_180s`: montar, `check` y seek con 90 escenas. Si no cabe en los timeouts, parar e informar.
- [ ] **Step 4: Commit.** `Vídeo: pruebas de aceptación de la fase 1 (SEO-xx)`
- [ ] **Step 5: R2 y lista para Marc.** Pasos manuales pendientes y condiciones de `VIDEO_ENGINE=1`: T0 aprobada, W3.x integradas, M-4 cerrada, M-5 medida, M2 hecha.

---

## Cobertura de invariantes

| Inv. | Dónde se prueba | | Inv. | Dónde se prueba |
|---|---|---|---|---|
| I1 | T1, T3, T4, T8, T9, T15 | | I9 | T12 (M-D4), Global Constraints |
| I2 | T3, T6, T9, T10, T17 | | I10 | T5, T9, T11, T15, T19 |
| I3 | Sin cambios; `render:sandbox` en T21 | | I11 | T6, T10, T20 |
| I4 | T10 (runtime), W3.2, T21 | | I12 | T2, W3.1 |
| I5 | T3, T5, T11, T20, T21 | | I13 | T6, sin cambios en `proceso.ts` |
| I6 | T4, T7, T10, T13, T14 | | I14 | T5, M-D3 |
| I7 | T6, T11 | | I15 | T5, T7 |
| I8 | T10, T12, T14, T17 | | | |

## Riesgos abiertos

- **La voz por partes puede sonar con cortes** entre frases. Sin `previous_text`, por simplicidad: añadirlo si se oye, sin cambiar el formato en disco.
- **`h264_mf` para clips** da poca calidad en equipos sin GPU. Depende de M-D6.
- **Recargar el iframe** en cada cambio cuesta más que parchear el DOM, pero es la misma vía que el render. Objetivo: ≤ 2 s con 50 s de vídeo. Parches, si se queda corto.
- **Fuera de la fase 1:** cancelar un render, porque `Jobs` no cancela. Añadir si los 13 minutos por 50 s se hacen largos.
- **Sin WebGPU en el iframe de WebView2 con la RTX** no hay dato todavía: M2.
- **Playwright no prueba Tauri:** `frame-src`, WebRTC y comandos Rust se cubren con tests de fichero, `cargo test` y comprobación manual.
- **Tope de ElevenLabs:** D7 dice 20 MB y W3.4 fija 64 MiB. T5 aplica D7.
