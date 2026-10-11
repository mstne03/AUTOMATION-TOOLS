# Informe: de `kb-seo` + `youtube-mcp-server` a un producto distribuible en `.exe`

## Contexto

Hoy tienes dos herramientas que funcionan, pero solo en tu máquina y solo a través de Claude Desktop:

- **`kb-seo`**: base de conocimiento vectorizada sobre algoritmos y SEO de YouTube, TikTok e Instagram. Postgres 17 + pgvector en Docker, embeddings `bge-m3` por Ollama, búsqueda híbrida (coseno + full-text, fusión RRF), servidor MCP por stdio con tres tools de solo lectura (`buscar_kb`, `listar_fuentes`, `estado_kb`). La ingesta es manual (`uv run ingest all`), sin scheduler, y 4 fuentes apuntan a rutas absolutas de otra máquina (`C:/Users/Pau/...`).
- **`youtube-mcp-server`**: servidor MCP por stdio con 42 tools sobre YouTube Data API v3, Analytics API y Reporting API, más transcripción local con faster-whisper. OAuth2 de aplicación de escritorio, un único token activo, cuota contabilizada en memoria por proceso, subida de vídeo implementada pero sin bucle de reanudación ni progreso.

El objetivo es convertirlos en **un producto gratuito, instalable en Windows como `.exe`**, con un agente de IA que consulte la base de conocimiento, analice el canal del usuario y publique vídeos ya editados rellenando título, descripción y metadatos.

Este documento es el informe pedido: arquitectura recomendada, tecnología, infraestructura, costes y hoja de ruta. No se ha tocado código.

---

## 1. Las tres decisiones que condicionan todo lo demás

Antes de hablar de frameworks hay tres preguntas de modelo de producto. Las respondo con una recomendación y explico qué se sacrifica en cada caso.

### 1.1 ¿Dónde se ejecuta el LLM del agente?

**Concepto previo.** Un agente es un bucle: el modelo recibe el estado, decide llamar a una herramienta (por ejemplo `youtube_analytics_top_videos`), el programa la ejecuta, el resultado vuelve al modelo y así hasta que responde. Con 42 herramientas y resultados JSON largos, el modelo tiene que razonar bien sobre **qué** herramienta usar y **cómo** encadenarlas. Esa capacidad es la que separa un modelo de 7B local de uno de frontera.

| Opción | Coste para el usuario | Calidad | Viabilidad |
|---|---|---|---|
| Ollama local (modelo ≤8B que quepa en 6,5 GB de VRAM) | 0 € | Insuficiente para orquestar 42 tools con fiabilidad; fallos silenciosos de selección de herramienta | Solo como modo degradado |
| API de Claude con clave propia del usuario (**BYOK**, *bring your own key*) | Céntimos por tarea (sección 5) | Alta | Viable |
| El producto paga la API | Gratis para el usuario | Alta | Inviable: producto gratuito con coste marginal por uso |

**Recomendación: BYOK con la API de Claude como vía principal, Ollama como opción secundaria solo para tareas acotadas** (resumir una transcripción, generar borradores de título sin tools). El usuario pega su clave de Anthropic en la app una vez; se guarda cifrada en el equipo y nunca pasa por ningún servidor tuyo.

Qué se sacrifica: fricción de onboarding (crear cuenta en Anthropic y meter tarjeta). Se mitiga con un asistente en la primera ejecución.

### 1.2 ¿De quién es el proyecto de Google Cloud que da acceso a YouTube?

**Conceptos previos.**

- Para hablar con la API de YouTube hace falta un **proyecto de Google Cloud** con las APIs activadas y un **cliente OAuth**. El usuario autoriza a ese cliente a actuar sobre su canal.
- La **cuota** de la Data API es de **10.000 unidades/día por proyecto**, no por usuario. Subir un vídeo cuesta 1.600 unidades según la documentación oficial (el tracker del repo usa ese valor; el agente de exploración apunta a que podría ser menor, hay que verificarlo contra la calculadora de cuota de Google antes de fiarse). Una búsqueda cuesta 100. Pedir más cuota exige pasar una auditoría de cumplimiento de Google, manual y de semanas.
- Los scopes de YouTube (`youtube.upload`, `youtube.force-ssl`, etc.) son **sensibles**. Un cliente OAuth sin verificar por Google está limitado a 100 usuarios de prueba, y sus autorizaciones caducan a los 7 días. Verificar es gratis pero requiere vídeo de demostración, política de privacidad, dominio verificado y justificación por scope.

| Opción | Cuota | Verificación Google | Onboarding del usuario |
|---|---|---|---|
| Un único proyecto tuyo compartido por todos los usuarios | 10.000 unidades/día **para todos juntos**: unas 6 subidas diarias en total | Obligatoria, más auditoría de cuota | Muy simple (un botón "Conectar YouTube") |
| Cada usuario crea su propio proyecto de Google Cloud y pega su `client_secret.json` | 10.000 unidades/día **por usuario** | No necesaria (cada proyecto es "interno" para su propio dueño) | Fricción alta: 8-10 pasos en la consola de Google |

**Recomendación: cada usuario aporta su propio proyecto de Google Cloud (BYO-project).** Es la única opción compatible con un producto gratuito: la cuota compartida convierte el producto en inservible a partir de media docena de usuarios activos. La fricción se ataca con un asistente paso a paso dentro de la app, con capturas, y con un validador que comprueba el `client_secret.json` y las tres APIs activadas antes de dejar continuar.

Qué se sacrifica: la experiencia de "un clic". Si más adelante el producto tiene tracción, se puede añadir el proyecto compartido verificado **como segunda vía**, sin rehacer nada, porque la capa de auth ya separará "credenciales" de "herramientas".

### 1.3 ¿Dónde se ingesta y actualiza la base de conocimiento?

**Concepto previo.** "Auto-actualizable" implica tres cosas: alguien decide qué fuentes entran, un proceso las revisita periódicamente, y el resultado llega al usuario. Ingestar requiere descargar páginas, trocear texto y calcular embeddings (vectores de 1.024 dimensiones por chunk), que es la parte cara en CPU.

| Opción | Dónde corre la ingesta | Qué necesita el usuario en su PC | Control de calidad de fuentes |
|---|---|---|---|
| Cada PC ingesta por su cuenta | En cada cliente | Modelo de embeddings completo + scraping periódico | Ninguno: cada usuario tendría una KB distinta |
| **Ingesta central en tu VPS, el cliente descarga un snapshot** | Tu VPS Hetzner | Solo un modelo pequeño para vectorizar la **consulta** (no el corpus) | Total: tú curas `sources.yaml` |

**Recomendación: ingesta centralizada en el VPS, distribución como snapshot firmado.** El VPS ejecuta la ingesta de `kb-seo` con un scheduler (systemd timer), exporta la base a un único fichero SQLite con la extensión `sqlite-vec`, lo firma y lo publica por HTTPS. La app comprueba cada día si hay snapshot nuevo, lo descarga, verifica la firma y lo sustituye de forma atómica.

Esto convierte la KB en algo **de solo lectura y verificable** en el cliente, elimina Docker y Postgres del instalador, y mantiene la curación de fuentes en tus manos. El cliente solo necesita vectorizar la pregunta del usuario, que es una operación de milisegundos en CPU con un modelo ONNX.

Qué se sacrifica: el usuario no puede añadir fuentes propias a la KB "pública". Se resuelve con una **segunda colección local y privada** (sección 2.4) donde van sus transcripciones, sus analíticas y las URLs que él quiera, vectorizadas con el mismo modelo.

---

## 2. Arquitectura recomendada

```
┌──────────────────────────── PC del usuario (instalador .exe) ────────────────────────────┐
│                                                                                          │
│  Tauri 2 (shell nativo, Rust mínimo)                                                     │
│   └─ WebView2 ── React + TypeScript (UI)                                                 │
│         │  HTTP+SSE a 127.0.0.1:<puerto aleatorio>, cabecera Authorization por arranque  │
│         ▼                                                                                │
│  Sidecar Python (PyInstaller --onedir)                                                   │
│   ├─ FastAPI: /chat (SSE), /jobs, /kb, /youtube, /settings                               │
│   ├─ Agente: Anthropic SDK Tool Runner (BYOK) · Ollama opcional                          │
│   ├─ Registro de tools: funciones Python reutilizadas de ambos repos                     │
│   │     ├─ youtube_* (publishing, analytics, transcripts, playlists, comments)           │
│   │     ├─ transcribe_local (faster-whisper)                                             │
│   │     └─ buscar_kb / listar_fuentes / estado_kb                                        │
│   ├─ Gate de aprobación: toda tool de escritura pasa por la UI antes de ejecutarse        │
│   ├─ KB pública: kb-public.sqlite (sqlite-vec + FTS5), solo lectura, firmada             │
│   ├─ KB privada: kb-private.sqlite (mismo esquema), escritura local                      │
│   ├─ Embeddings de consulta: ONNX Runtime + modelo multilingüe bundled                   │
│   └─ Secretos: Windows DPAPI via keyring (API key, client_secret, tokens OAuth)          │
│                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                 │ HTTPS (descarga snapshot + manifest firmado)            │ HTTPS
                 ▼                                                          ▼
┌──────── VPS Hetzner (tuyo) ────────┐                    ┌── APIs externas ──────────────┐
│ kb-seo ingest (systemd timer)      │                    │ api.anthropic.com (clave user) │
│ Postgres+pgvector (solo ingesta)   │                    │ googleapis.com (proyecto user) │
│ export → sqlite-vec → firma ed25519│                    └────────────────────────────────┘
│ Caddy: /kb/manifest.json, /kb/*.db │
└────────────────────────────────────┘
```

### 2.1 Frontend y empaquetado: Tauri 2 + React/TypeScript

**Por qué Tauri y no Electron.** Tauri usa el WebView2 que ya trae Windows 11 en vez de empaquetar Chromium: el instalador pesa decenas de MB en vez de cientos, y el consumo de RAM es menor. Tauri 2 genera instaladores NSIS (`-setup.exe`) y MSI, trae un **updater** con firma integrado y un mecanismo de **sidecar** (`externalBin`) pensado exactamente para arrastrar un binario externo como el Python empaquetado.

Lo que sacrificas con Tauri: el shell es Rust. En este diseño el Rust se limita a tres cosas (lanzar el sidecar con un token aleatorio, exponer el puerto a la UI y cerrar el sidecar al salir), y hay plugins oficiales para cada una (`tauri-plugin-shell`, `tauri-plugin-updater`). Si la fricción con Rust resultara un bloqueo, Electron es el plan B sin cambiar nada del backend ni de la UI.

Pitfall conocido a vigilar: con el instalador NSIS, Tauri puede reutilizar una copia cacheada antigua del sidecar entre builds; hay que limpiar `target/release` y comprobar que el instalador lleva el binario nuevo en cada release.

**UI.** React + TypeScript + Vite, estado con TanStack Query para las llamadas al sidecar y un stream SSE para el chat del agente. Pantallas mínimas:

1. Onboarding: clave de Anthropic, asistente de proyecto Google, autorización OAuth, descarga inicial de KB.
2. Chat con el agente, con tarjetas de aprobación inline para cada acción de escritura.
3. "Publicar vídeo": selector de fichero, transcripción local, borrador generado (título/descripción/tags/categoría/`publishAt`/miniatura), edición manual, confirmación, barra de progreso de subida.
4. Panel de canal: analíticas con los endpoints existentes.
5. Base de conocimiento: estado del snapshot, fuentes privadas del usuario.
6. Ajustes: modelo, proveedor, cuota consumida, carpetas permitidas.

### 2.2 Backend local: sidecar Python con FastAPI

**Concepto previo: sidecar.** Es un proceso auxiliar que el shell lanza y supervisa. La UI no ejecuta Python; habla con él por HTTP en localhost. Esto permite reutilizar los dos repos tal cual y empaquetarlos con PyInstaller.

Decisiones:

- **Reutilizar las funciones, no los servidores MCP.** Las tools de ambos repos son funciones Python normales registradas con decoradores (`@mcp.tool`). El agente las llama en proceso a través de un registro propio que las envuelve con metadatos: nombre, esquema JSON, **nivel de riesgo** (`read` / `write` / `destructive`) y coste de cuota. Las fachadas MCP por stdio se conservan como interfaz opcional para quien quiera seguir usando Claude Desktop, pero dejan de ser la ruta principal.
- **Bucle del agente con el Tool Runner del SDK de Anthropic** (`client.beta.messages.tool_runner` + `@beta_tool`), modelo por defecto `claude-opus-5-5` y `claude-sonnet-5-5` como opción económica seleccionable en ajustes. Los hooks por turno del runner son el punto donde se inserta el gate de aprobación y el logging. Prompt caching sobre el prefijo estable (system prompt + definiciones de tools) para que las 42 tools no se paguen a precio completo en cada turno.
- **Gate de aprobación obligatorio.** La salida del modelo es entrada no confiable. Toda tool marcada `write` o `destructive` (subir, actualizar, borrar vídeo, comentar, crear playlist, crear job de reporting) devuelve primero una **propuesta** a la UI; solo se ejecuta cuando el usuario confirma. Las `destructive` (borrar vídeo) exigen además escribir el ID. Esto es lo que tu propio perfil pide para agentes que ejecutan lo que devuelve el modelo.
- **Trabajos largos como jobs.** Subida de vídeo y transcripción no pueden bloquear una petición HTTP. Van a una cola en proceso (`asyncio` + estado en SQLite) con endpoint de progreso. La subida se reescribe con el bucle `next_chunk()` de `MediaFileUpload` resumable, reintentos con backoff y reanudación tras corte de red.
- **FastAPI** porque `mcp` ya arrastra Starlette y Uvicorn en el lock de `kb-seo`: no se añade ninguna dependencia nueva de peso.

### 2.3 Base de conocimiento pública: pipeline en el VPS y snapshot en el cliente

En el VPS se mantiene `kb-seo` casi intacto (Postgres + pgvector + Ollama `bge-m3`), con estos cambios:

1. **Scheduler**: systemd timer diario que ejecuta `ingest all`. Ya es idempotente por `content_hash`.
2. **Fuentes vivas**: para las 4 páginas renderizadas por JavaScript que hoy se capturan a mano, sustituir el fichero local por un extractor `playwright` headless en el VPS. Elimina la deuda de rutas absolutas `C:/Users/Pau/...`.
3. **Exportador** `kb-export`: vuelca `documents` y `chunks` (con embeddings y texto) a un fichero SQLite con tablas `vec0` de `sqlite-vec` y una tabla virtual FTS5 para el full-text. La búsqueda híbrida con RRF del repo se porta a SQL de SQLite casi línea a línea; el cliente mantiene la misma semántica de `buscar_kb`.
4. **Firma y publicación**: `minisign` (ed25519) sobre el `.db` y un `manifest.json` con versión, fecha, tamaño y hash. Caddy sirve `/kb/` en solo lectura con TLS automático. No hay autenticación porque no hay datos de usuario, pero la firma garantiza que nadie puede inyectar contenido en la KB de los clientes aunque comprometa el hosting.

En el cliente:

- Descarga el manifest, compara versión, descarga el `.db` a un temporal, verifica la firma con la clave pública embebida en el binario, y lo mueve de forma atómica.
- **Embeddings de consulta**: el cliente tiene que vectorizar la pregunta con **el mismo modelo** que vectorizó el corpus. Esto obliga a elegir el modelo pensando en el cliente: `bge-m3` en ONNX ocupa más de 500 MB incluso cuantizado. Recomiendo migrar el corpus a **`multilingual-e5-small`** (unos 120 MB en ONNX, 384 dimensiones, multilingüe, calidad suficiente para un corpus de cientos de documentos) servido con `onnxruntime` o `fastembed`. Es un cambio de modelo en el VPS y una reingesta; `EMBED_DIM` ya es configurable aunque el esquema tenga `VECTOR(1024)` fijo, que habrá que migrar.
- Ollama deja de ser requisito para el usuario. Sigue siendo opcional para quien quiera LLM local.

### 2.4 Base de conocimiento privada

Mismo esquema SQLite, segundo fichero, con escritura. Ahí entran, vectorizados con el mismo modelo ONNX en el cliente:

- Transcripciones de los vídeos del canal (vía `youtube_get_transcript` o `transcribe_local`).
- Resúmenes de analíticas por vídeo, para que el agente pueda responder "qué funcionó en mis últimos 20 shorts".
- URLs que el usuario añada a mano (se reutiliza `ingest/extractors.py`).

El agente busca en ambas colecciones y cita de cuál viene cada bloque.

### 2.5 Autenticación y secretos

- **Clave de Anthropic, `client_secret.json` y tokens OAuth** se guardan con `keyring`, que en Windows usa el **Credential Manager** protegido por DPAPI (cifrado ligado a la sesión del usuario). Hoy el token se escribe en JSON plano con el `refresh_token` dentro; con los scopes actuales ese fichero equivale a control total del canal.
- **Multicanal de primera clase**: perfil por canal con su propio token, seleccionable en la UI. Resuelve el apaño manual de `token-candisito.json` / `token-smooth.json` y el cacheo del ID de canal por proceso.
- **Refresco de token**: si falla, el sidecar devuelve un estado "reautorizar" a la UI; nunca abre el navegador desde el proceso del agente ni se traga la excepción.
- **Sidecar**: escucha en `127.0.0.1` y puerto aleatorio; Tauri genera un token por arranque y la UI lo envía en cada petición. Sin él, cualquier proceso local podría pedirle al sidecar que suba o borre vídeos.

### 2.6 Correcciones de seguridad heredadas que entran en el alcance

Detectadas en la exploración y que hay que cerrar antes de distribuir:

1. `youtube_reporting_download` envía el `Bearer` a **cualquier** URL. Restringir a hosts `*.googleapis.com`.
2. `youtube_upload_video` y `youtube_set_thumbnail` leen cualquier ruta del disco. Aplicar la misma lista de carpetas permitidas que ya tiene `transcribe_local`, configurable desde la UI, y quitar las rutas hardcodeadas `C:\Ferguson`, `C:\Adobe`, `C:\Kanye`.
3. `youtube_delete_video` sin confirmación: cubierto por el gate de aprobación.
4. Cuota en memoria por proceso y con cambio de día en hora local: persistir en SQLite y usar medianoche del Pacífico, que es cuando Google reinicia.
5. Contenido web de la KB devuelto tal cual al modelo (inyección indirecta): el system prompt debe tratar los bloques de `buscar_kb` como datos, y el gate de aprobación es la segunda barrera.
6. `.gitignore` de `youtube-mcp-server` no excluye `token*.json` ni `client_secret*.json` fuera de `secrets/`. Añadirlos. El repo no es git hoy; al inicializarlo, hacerlo antes del primer commit.
7. Errores de tools al cliente con `type(e).__name__: e`: filtrar para no exponer host/usuario de conexión.

### 2.7 Transcripción local

Se mantiene faster-whisper `small`. En el instalador no va el modelo (unos 500 MB): se descarga en la primera transcripción desde Hugging Face y se cachea. GPU CUDA si existe, CPU int8 si no. El extra `gpu` (`nvidia-cublas-cu12`) se incluye en el bundle para no pedir instalación aparte.

---

## 3. Tecnología recomendada (resumen)

| Capa | Elección | Motivo principal | Alternativa descartada y por qué |
|---|---|---|---|
| Shell de escritorio | Tauri 2 | Instalador ligero, updater firmado, sidecar nativo | Electron: 150+ MB extra, sin updater firmado de serie |
| UI | React + TypeScript + Vite + TanStack Query | Tu stack fuerte, SSE sencillo | Svelte: sin ventaja real aquí |
| Backend local | Python 3.12 + FastAPI, empaquetado con PyInstaller `--onedir` | Reutiliza ambos repos; Starlette/Uvicorn ya están en el lock | Reescribir en Rust/TS: tira 150 tests y meses |
| Agente | Anthropic SDK Tool Runner, `claude-opus-5-5` por defecto, Sonnet 5.5 opcional, BYOK | Hooks por turno para el gate; caching de prefijo | Ollama como principal: no orquesta 42 tools con fiabilidad |
| KB pública | SQLite + `sqlite-vec` + FTS5, snapshot firmado con minisign | Un fichero, sin servidor, verificable | LanceDB: más capaz pero más dependencias y sobredimensionado para cientos de documentos. Postgres en cliente: imposible en un `.exe` |
| Embeddings cliente | `multilingual-e5-small` ONNX via `onnxruntime`/`fastembed` | 120 MB, CPU, multilingüe | `bge-m3` ONNX: >500 MB en el instalador |
| Ingesta (VPS) | `kb-seo` actual + systemd timer + Playwright para páginas JS | Ya funciona; solo se automatiza | Ingesta en cliente: sin control de fuentes |
| Secretos | `keyring` (Windows Credential Manager / DPAPI) | Cifrado ligado al usuario, estándar | JSON plano: control total del canal a quien lea el fichero |
| Jobs largos | `asyncio` + estado en SQLite | Suficiente para un solo usuario | Celery/Redis: sobredimensionado |
| Transcripción | faster-whisper `small`, modelo descargado en primer uso | Ya integrado y probado | Whisper API en la nube: coste y envío del vídeo fuera |
| Distribución | NSIS vía Tauri + `tauri-plugin-updater`, firma de código | SmartScreen y actualizaciones automáticas | Sin firma: aviso rojo de Windows en cada instalación |

---

## 4. Infraestructura necesaria

### 4.1 Del lado del usuario

- Windows 10/11 x64 con WebView2 (incluido en Windows 11; el instalador descarga el bootstrapper si falta).
- 4 GB de RAM libres, 2 GB de disco (instalador ~250 MB con Python y ONNX Runtime, más 500 MB de Whisper en el primer uso, más la KB de decenas de MB).
- GPU NVIDIA opcional: acelera Whisper. Sin ella funciona en CPU.
- Cuenta de Anthropic con clave de API.
- Cuenta de Google propietaria del canal y un proyecto de Google Cloud propio con las tres APIs activadas.

### 4.2 Del lado tuyo (operador)

- **VPS Hetzner** (ya existe): ingesta diaria, Postgres, Ollama o un modelo ONNX en CPU para los embeddings del corpus, Caddy sirviendo el snapshot. Un CX22 sobra. Sigue accesible solo por Tailscale; el único puerto público es 443 para `/kb/`.
- **Clave de firma minisign** guardada fuera del VPS (en tu máquina, con copia cifrada). El VPS solo firma si le pasas la clave en el momento del release; mejor aún, firma desde tu máquina en el pipeline de release y sube el fichero ya firmado.
- **CI/CD**: GitHub Actions con runner Windows para compilar Tauri + PyInstaller y publicar releases con los artefactos del updater.
- **Certificado de firma de código** para evitar el aviso de SmartScreen (sección 5.2).
- **Dominio** para el snapshot y la página de descarga.

### 4.3 Lo que desaparece respecto a hoy

Docker Desktop, Postgres y Ollama dejan de ser requisitos en el PC del usuario. Claude Desktop deja de ser el único cliente.

---

## 5. Costes

### 5.1 Para el usuario (producto gratuito)

**Google Cloud / YouTube APIs: 0 €.** Las tres APIs son gratuitas dentro de la cuota de 10.000 unidades/día del proyecto propio. Lo que sí limita es la cuota: con el coste oficial de 1.600 unidades por subida, el techo son unas 6 subidas al día más las consultas de lectura (1 unidad cada una). Las analíticas y el reporting no consumen esa cuota.

**API de Claude (BYOK).** Precios vigentes de Anthropic por millón de tokens:

| Modelo | Entrada | Salida | Lectura de caché |
|---|---|---|---|
| `claude-opus-5-5` | 4 $ | 20 $ | 0,20 $ |
| `claude-sonnet-5-5` | 2 $ | 10 $ | 0,20 $ |
| `claude-haiku-5-5` | 0,10 $ | 0,50 $ | — |

Estimación por tarea típica, con prompt caching activo sobre system prompt y definiciones de tools (supuestos: ~10 llamadas a herramientas, ~60.000 tokens de entrada de los que el 80 % son lectura de caché, ~5.000 tokens de salida):

| Tarea | Opus 5.5 | Sonnet 5.5 |
|---|---|---|
| "Analiza mi canal y dime qué mejorar" (lectura de analíticas + KB) | ~0,15-0,25 $ | ~0,08-0,12 $ |
| "Prepara y sube este vídeo" (transcripción local + borrador + subida) | ~0,10-0,20 $ | ~0,05-0,10 $ |
| Pregunta suelta a la KB sin analíticas | ~0,02-0,05 $ | ~0,01-0,03 $ |

Para un creador que publica 20 vídeos al mes y consulta analíticas a diario, el orden de magnitud es **5-15 $/mes con Opus y 2-6 $/mes con Sonnet**. Estas cifras son estimaciones a partir de precios de lista; la app debe mostrar el gasto acumulado leyendo `usage` de cada respuesta para que el usuario lo vea en tiempo real.

**Hardware y energía:** la transcripción local en CPU de un vídeo de 10 minutos tarda unos minutos; con GPU, segundos. Sin coste monetario.

**Opción 0 € total:** Ollama local para tareas acotadas sin tools (borradores de título a partir de una transcripción). Hay que advertir en la UI de la pérdida de calidad y de que el modo agente completo no está disponible en ese modo.

### 5.2 Para ti como operador

| Concepto | Coste orientativo | Nota |
|---|---|---|
| VPS Hetzner CX22 | ~4-8 €/mes | Ya lo tienes |
| Dominio | ~10-15 €/año | |
| Firma de código Windows | Azure Trusted Signing ~10 $/mes, o certificado OV ~200-400 $/año | Sin firma, SmartScreen muestra un aviso rojo y la tasa de instalación cae. Gasto recurrente real del proyecto |
| Verificación OAuth de Google | 0 € | Solo si algún día ofreces el proyecto compartido. Horas de trabajo: vídeo demo, política de privacidad, dominio |
| Auditoría de cuota de YouTube | 0 € | Idem; semanas de espera, no garantizada |
| CI en GitHub Actions | 0 € en repos públicos; minutos Windows de pago en privados | |
| Tokens de Claude durante desarrollo y pruebas | Variable | Tu propia clave |

---

## 6. Hoja de ruta por fases

Cada fase es entregable por sí sola y la siguiente no la invalida.

**Fase 0. Saneamiento de los dos repos (1-2 semanas).**
Inicializar git en `youtube-mcp-server` con `.gitignore` corregido. Cerrar los 7 puntos de seguridad de la sección 2.6. Reescribir la subida con bucle resumable, progreso y reintentos. Persistir la cuota. Soporte multicanal en `auth.py`. Añadir `publishAt` a `youtube_update_video`. Exponer `playlist_item_id` en `youtube_list_videos`. Actualizar costes de cuota tras verificarlos contra la calculadora oficial. Tests existentes (unos 75 + 104) siguen pasando.

**Fase 1. Backend local unificado (2-3 semanas).** *Hecha el 2026-10-11 (`app-backend/`).*
Paquete `app-backend` con FastAPI, registro de tools con niveles de riesgo, bucle de agente con el Tool Runner, gate de aprobación, cola de jobs, `keyring`. Probar por `curl`/Postman sin UI. Un test E2E por flujo: pregunta a la KB, análisis de canal, publicación completa con aprobación.

Desviaciones respecto a lo previsto: el gate de aprobación se implementa dentro de la función envuelta de cada tool (el runner la ejecuta y ella espera la decisión) en vez de en los hooks por turno, porque con llamadas paralelas cada propuesta se bloquea de forma independiente y el modelo recibe el rechazo como resultado normal; `keyring` trocea los valores porque el Credential Manager limita cada credencial a 2560 bytes UTF-16; los jobs esperan dentro de la tool (el agente recibe el resultado cuando acaba) y el progreso se consulta por `GET /jobs/{id}`. Los tres E2E con credenciales reales se ejecutaron el 2026-10-11 contra Anthropic (`claude-opus-5-5`), YouTube y el Postgres local: pregunta a la KB con citas, análisis de canal (4 unidades de cuota) y publicación completa (rechazo de la propuesta sin subir nada; aprobación, subida como privado por la cola de jobs, borrado con el gate destructivo repitiendo el ID). El caché de prompt sirvió 13.861 tokens de tools + system en cada turno. Hallazgo que solo salió en E2E real: la API limita a 20 las tools con `strict: true`, así que solo las write/destructive van estrictas.

**Fase 2. KB como snapshot (1-2 semanas, en paralelo con la 1).** *Hecha y verificada el 2026-10-11, VPS incluido.*
Migración a `multilingual-e5-small`, exportador a `sqlite-vec`+FTS5, port de la búsqueda híbrida RRF, firma minisign, systemd timer y Playwright en el VPS, cliente de actualización con verificación de firma. KB privada con el mismo esquema.

Desviaciones respecto a lo previsto: (1) **sin Postgres ni Ollama en el VPS**: la ingesta escribe directamente en SQLite (`KB_BACKEND=sqlite`) y `kb-export` hace `VACUUM INTO`; Postgres queda como backend de desarrollo y referencia de paridad (los tests comprueban que la misma consulta devuelve los mismos documentos en el mismo orden en ambos). Menos piezas en el servidor, mismo resultado. (2) **Nginx en vez de Caddy**: el VPS ya tiene Nginx + certbot sirviendo tres subdominios; un segundo servidor en 80/443 no cabe. `kb.mstne.dev` sirve `/kb/` estático de solo lectura. (3) `multilingual-e5-small` no viene de serie en `fastembed` 0.9 (solo el `large`, 1 GB): se registra como modelo custom desde el ONNX oficial de HuggingFace (mean pooling + normalización). (4) La firma se hace con `kb-sign` (ed25519 en Python, formato minisign "ED" prehashed, verificable con el binario `minisign`) para no depender de un paquete apt; la clave secreta vive en `~marc/kb-seo/keys/` con 0600 y sin contraseña porque la firma la ejecuta un timer sin nadie delante. (5) El ranking de la rama full-text es bm25 en SQLite y `ts_rank` en Postgres; en las consultas de prueba el orden final tras RRF coincide. Medido: búsqueda en caliente 59 ms sobre el snapshot; carga del modelo ONNX en frío 5-8 s (y ~120 MB de descarga la primera vez: la Fase 4 debe empaquetar el modelo con el instalador). Verificado E2E: chat real contra el snapshot con citas y URL; cliente descargando, verificando e instalando el snapshot firmado en el VPS, y rechazando un manifest manipulado conservando la versión instalada. Marc ejecutó `deploy/install.sh` y `deploy/setup-user.sh` el mismo día: `https://kb.mstne.dev/kb/manifest.json` publica las 19 fuentes (116 chunks), el timer diario está activo (04:30 UTC) y el cliente instaló ese snapshot desde la URL de producción con la clave embebida.

**Fase 3. Interfaz Tauri + React (3-4 semanas).** *Hecha el 2026-10-11 (`app-ui/`).*
Las seis pantallas de la sección 2.1. Sidecar lanzado desde Tauri con token por arranque. Tests E2E de UI estrictos contra el comportamiento descrito (no hay Figma: exigir layout y estados definidos antes de empezar cada pantalla).

Resultado: Tauri 2 + React 19 + Vite + TanStack Query, con el contrato de layout y estados escrito antes de cada pantalla en `app-ui/docs/pantallas.md`. El Rust se queda en lo previsto (token por arranque, lectura del puerto, comando `sidecar_info`, kill al salir) y el WebView no tiene permiso de shell. Dos hallazgos que solo salieron al conectar las piezas de verdad, ambos resueltos en `app-backend`: el WebView es un origen distinto y el sidecar necesitaba CORS restringido a `tauri.localhost` y `localhost:1420`; y el sidecar anunciaba el puerto antes de hacer `listen()`, así que la primera petición se rechazaba durante los segundos de arranque de uvicorn. El flujo de publicación de la Fase 1 se repitió desde el chat con la UI real (rechazo, subida por la cola de jobs con la ruta resuelta visible, borrado destructivo tecleando el ID). Los E2E (20 con Playwright) arrancan el sidecar real con secretos en fichero y un Anthropic falso por `ANTHROPIC_BASE_URL`, de modo que el gate de aprobación y el stream SSE son los de producción y el modelo es determinista. Pendiente para la Fase 4: atar el sidecar a un Job Object (un cierre forzoso de la app lo deja huérfano) y sustituir `uv run` por el `externalBin` empaquetado.

**Fase 4. Empaquetado y distribución (1-2 semanas).** *Hecha el 2026-10-11 (sin firma de código; CI pendiente de subir el monorepo a GitHub).*
PyInstaller `--onedir` con hidden imports verificados, instalador NSIS, updater firmado, firma de código, pipeline en GitHub Actions, prueba de reinstalación sobre versión anterior (el bug del sidecar cacheado).

Resultado: `app-backend/app-backend.spec` congela el sidecar en `dist/app-backend/` (≈ 900 MB) con el modelo de embeddings dentro (`EMBED_MODEL_PATH` → `fastembed(specific_model_path=…)`, `HF_HUB_OFFLINE=1`) y sin leer ningún `.env` cuando `sys.frozen`; `scripts/smoke_test.py` lanza el binario, lee la línea JSON, comprueba el 401 sin token, `GET /settings` y `GET /kb/buscar` con la red cerrada (puerto anunciado a los 12,8 s, búsqueda con el modelo embebido a los 17,7 s). Tauri lo arrastra como `externalBin` + `resources` (`_internal/`), instalador NSIS por usuario, y el sidecar entra en un Job Object `KILL_ON_JOB_CLOSE` (solo él, no la app, para que el instalador del updater no muera con ella): verificado que `taskkill /F` de la app mata `uv.exe` y `python.exe`. Updater con `tauri-plugin-updater` y clave minisign propia (privada en `~/.tauri/seo-studio.key`, fuera del repo; pública en `tauri.conf.json`), manejado desde Rust para que el WebView siga con `core:default`; la UI avisa al arrancar y solo instala tras confirmación. Pipeline `.github/workflows/release.yml` (tag `vX.Y.Z`): tests, modelo, PyInstaller, smoke test, build + firma + release en borrador con `latest.json`, y comprobación del SHA-256 del sidecar empaquetado contra el recién compilado. El VPS sirve `/app/latest.json` y los instaladores (Nginx) y los publica con `deploy/publish-app.sh` tirando de la release de GitHub: CI no tiene acceso al servidor.

Desviaciones respecto a lo previsto: (1) **sin firma de código**: SmartScreen avisará en la primera ejecución; un certificado OV/EV (200-400 €/año) queda como decisión de Marc si hay tracción, y la integridad real la garantiza la firma minisign del updater. (2) **El modelo ONNX pesa 470 MB, no ~120 MB** como decía la Fase 2 (fp32; 250k tokens de vocabulario): el instalador ronda los 600-700 MB y `makensis` con LZMA tarda mucho; no se cuantiza porque los vectores dejarían de coincidir con el snapshot del VPS. (3) `tauri-plugin-process` no hace falta: el instalador NSIS relanza la app. (4) El `_ctypes` del Python de Anaconda no es empaquetable (falta `ffi.dll`): el venv de `app-backend` debe usar el CPython de `uv`, que es el que usa CI. (5) Arranque del sidecar congelado ≈ 13 s hasta anunciar el puerto (imports desde `_internal`), dentro de los 60 s que espera `sidecar_info`. Pendientes que son de Marc: subir el monorepo a GitHub y crear los secretos `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`; copiar la clave privada al gestor de contraseñas; pasar la app OAuth de Google a "En producción" (en modo Prueba el `refresh_token` caduca a los 7 días); reinstalar `deploy/install.sh` en el VPS para el bloque `/app/` de Nginx.

**Fase 5. Opcional, solo con tracción.**
Proyecto OAuth compartido verificado por Google como segunda vía de conexión; auditoría de cuota.

---

## 7. Riesgos y cómo se mitigan

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Onboarding de Google Cloud demasiado complejo para el público objetivo | Abandono en la instalación | Asistente guiado con validador de cada paso; vídeo tutorial; Fase 5 como salida si hay tracción |
| Cambios de coste de cuota o de política de YouTube | Techo de subidas distinto al previsto | Costes de cuota en un fichero de configuración actualizable con el snapshot, no en código |
| Tamaño del instalador por ONNX Runtime + ctranslate2 | Descarga lenta | Whisper y su modelo descargados en primer uso; ONNX Runtime CPU-only (sin CUDA) en el bundle, CUDA como descarga opcional |
| Instalador de 600-700 MB por el modelo ONNX fp32 (470 MB) | Descarga lenta; `makensis` lento | Modelo embebido es imprescindible para funcionar sin red; cuantizar exigiría reingestar el VPS con el mismo modelo cuantizado (opción futura) |
| Alucinación de herramientas por el modelo | Acción no deseada | Gate de aprobación en todo lo que escribe; `strict: true` en los esquemas de las tools |
| PyInstaller y dependencias nativas (lxml, av, ctranslate2) | Build frágil | Lista explícita de hidden imports y test de arranque del sidecar en CI en cada build |
| Snapshot corrupto o manipulado | KB envenenada en todos los clientes | Firma ed25519 verificada antes de activar; sustitución atómica; versión anterior conservada para rollback |

---

## 8. Supuestos que he tomado y que conviene confirmar

1. **BYOK con Claude como LLM principal.** Si prefieres que el producto funcione sin clave de pago, la arquitectura no cambia, pero el "agente" se reduce a flujos fijos sin bucle de herramientas sobre Ollama.
2. **Cada usuario aporta su proyecto de Google Cloud.** Si quieres la experiencia "un clic" desde el día uno, hay que asumir verificación de Google, auditoría de cuota y que el producto no escala en cuota; lo desaconsejo para un producto gratuito.
3. **Solo Windows en la primera versión.** Tauri y PyInstaller permiten macOS y Linux después; no está contemplado ahora.
4. **La KB pública la curas tú** desde `sources.yaml`; los usuarios solo tienen KB privada.
5. **Cambio de modelo de embeddings** a uno pequeño para hacer viable el cliente. Implica reingestar el corpus en el VPS.

## Verificación de este plan

Al tratarse de un informe, la verificación es que las afirmaciones sobre el código se corresponden con lo explorado (ambos repos leídos en su totalidad por los agentes de exploración y los README y ficheros de configuración leídos de primera mano) y que los datos externos (precios de Anthropic, límites de OAuth y cuota de Google, estado de `sqlite-vec` y Tauri 2) proceden de fuentes consultadas hoy. El único dato que queda marcado como **pendiente de verificar** es el coste real en unidades de `videos.insert`, que hay que contrastar con la calculadora de cuota oficial de Google antes de la Fase 0.
