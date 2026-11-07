# Handoff · Sesión en la nube: Trivy en la CI y tareas de la fase 1 que no necesitan Windows

> Para una sesión de Claude Code en la nube (contenedor Linux con acceso a `mstne03/AUTOMATION-TOOLS`). Léelo entero
> antes de empezar. Lo escribió la sesión local que integró las oleadas 0–3 del módulo Vídeo (PR 22) el 2026-11-07.

## 0. Antes de nada

- **Rama base:** `ds/v1` si la PR 22 (`feat/video-fase1` → `ds/v1`) ya está fusionada; si no, `feat/video-fase1`.
  Compruébalo con `gh pr view 22 --repo mstne03/AUTOMATION-TOOLS --json state`.
- Lee `CLAUDE.md` (raíz), `PLAN-video-fase1.md` (secciones «Decisiones que necesitan a Marc», «Entrada y orden» y las
  tareas que te tocan) y, de `SPEC-video.md`, la sección de Seguridad (invariantes I1–I15). No leas informes enteros:
  busca y lee el trozo que necesites.
- **Esta sesión no tiene Windows, ni GPU, ni Chrome for Testing win64, ni las referencias SSIM de Marc.** Los tests
  marcados `describe.runIf(process.platform === "win32")` se saltan aquí: un verde local **no** prueba nada de Windows.
  Lo de Windows lo prueban los jobs `video` y `backend-windows` de la CI (`windows-latest`). Cada vuelta de CI tarda
  ~15 min: no la uses para adivinar; reproduce y mide antes.

## 1. Normas de Marc (su CLAUDE.md global no viaja a la nube)

- **Idioma:** español con ortografía completa, también en código, comentarios, commits y docs. Di siempre
  «ejecución», nunca «corrida». Identificadores y términos técnicos, en su forma original.
- **Cómo explicarle:** en IA, ciberseguridad, backend, cloud y DevOps, modo didáctico: explica cada concepto antes de
  decidir. En frontend, ritmo normal. Recomienda con argumentos y trade-offs; no le pases un selector a ciegas.
- **Prioridades:** robustez > mantenibilidad > escalabilidad > simplicidad, por encima de coste y velocidad. Si un atajo
  sacrifica algo, dilo. Incluye siempre las implicaciones de seguridad.
- **Git** (lo vigilan los hooks de `.githooks/`; actívalos con `git config core.hooksPath .githooks`):
  - Ramas `<tipo>/<slug>` (`feat`, `fix`, `chore`, `docs`, `ds`). **Nunca `claude/…`**: si arrancas en una, crea la
    buena antes del primer commit.
  - Autor: `git config user.name "Marc Serra"` y `git config user.email "mserraitorne@gmail.com"`.
  - Mensajes en español, imperativo, primera línea ≤ 72 caracteres, con el issue: `… (SEO-xx)`.
  - **Sin atribución en ningún sitio**: ni `Co-Authored-By`, ni «Generated with Claude Code», ni enlaces de sesión, en
    commits, PRs ni comentarios. Nunca `--no-verify`.
  - Descripción de PR: *Qué cambia* · *Por qué* (`SEO-xx`) · *Cómo se ha probado* · *Pasos manuales pendientes*.
  - **Push a tu rama, sí. PR, fusión o push a `ds/v1`/`main`: solo con el sí explícito de Marc.**
- **Descargas:** cualquier descarga necesita su permiso, indicando nombre, origen y tamaño. Para la tarea A este
  handoff ya lo da, con los límites de §2.3. Para cualquier otra, pregúntale.
- **Presupuesto de contexto (obligatorio):** ni la sesión ni un subagente pasan del 60 % de su ventana; si una tarea
  no cabe, pártela antes. Subagentes: encargo estrecho, modelo explícito (Sonnet por defecto; Opus solo para seguridad
  crítica o diseño), máximo 3 a la vez y respuesta de ≤ 20 líneas con el detalle en un fichero. Pasa rutas, no
  contenido. Ejecuciones largas en segundo plano, leyendo solo el resumen. Una revisión por paquete y una re-revisión
  acotada al diff de la corrección.
- **Seguridad transversal:** la salida de un modelo es entrada no confiable (nunca se pinta como HTML). Lo nativo del
  WebView va por comandos Rust (`core:default`). Los `data-testid` de `app-ui/docs/pantallas.md` son contrato de los
  E2E. El entorno de los procesos hijos del motor es una lista blanca (I5).

## 2. Tarea A · Trivy en la CI (empieza por aquí)

### 2.1 Por qué

`.github/workflows/ci.yml` ya tiene `dependencias` (pip-audit, `pnpm audit`, `npm audit`; producción, nivel high),
`secretos` (gitleaks) y `workflows-y-scripts` (actionlint, zizmor, shellcheck). Trivy (`trivy fs`) añadiría:

- **Cargo** (`app-ui/src-tauri/Cargo.lock`): ningún job lo audita. Un triaje de Dependabot del 2026-11-06 dejó
  8 alertas abiertas ahí.
- **Misconfig** de `kb-seo/deploy/` (Dockerfile, compose, YAML).
- **Una segunda base de vulnerabilidades**, independiente de las de pip-audit y npm.

El escáner de secretos de Trivy, desactivado: ya lo cubre gitleaks.

### 2.2 Riesgo de cadena de suministro (no lo saltes)

Un escáner corre en la CI con acceso al código. La sesión local recordaba, sin verificarlo, que en 2026 se publicaron
etiquetas y versiones comprometidas de las GitHub Actions de Trivy. **Verifícalo en fuentes oficiales** (advisories de
`aquasecurity/trivy` y `aquasecurity/trivy-action` en GitHub) antes de elegir versión, y cuéntale a Marc lo que
encuentres. En cualquier caso:

- **No uses `aquasecurity/trivy-action` ni `setup-trivy` por etiqueta.** Instala el binario de una release fija,
  publicada después de cualquier incidente, y verifica su SHA-256 contra el fichero de checksums de esa release. Si
  la release trae firma (cosign o attestations), verifícala también. Es el mismo patrón que el paso «ffmpeg LGPL del
  instalador» del job `video`.
- Job con `permissions: contents: read`, `persist-credentials: false` en el checkout, sin secretos y sin escribir
  nada de vuelta.
- Las otras actions del job, fijadas por SHA, como el resto del workflow (zizmor lo exige).

### 2.3 Qué hacer

1. Job `trivy` en `ubuntu-latest`. Que se ejecute siempre, porque toca todos los subproyectos, y que entre en
   `needs` de `ci-ok`.
2. `trivy fs --scanners vuln,misconfig --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 .`. Excluye lo que
   no es del producto (`spikes/`, fixtures de tests) solo si hace falta y razonándolo en un comentario.
3. Excepciones en `.trivyignore`, cada una con un comentario: qué es, por qué no aplica o no se puede corregir, y
   cuándo revisarla. Mismo criterio que el comentario de `pip-audit` del job `dependencias`.
4. Caché de la base de vulnerabilidades (`actions/cache`, clave por fecha). Que la descargue Trivy en la CI es
   aceptable: es red del runner, no de la máquina de Marc.
5. Si Trivy encuentra vulnerabilidades reales (Cargo, sobre todo), **no las corrijas en esta tarea**: lístalas con
   paquete, versión, CVE, versión que corrige, si es de producción y si es alcanzable, y propónselas a Marc como
   tarea aparte.
6. **Descargas autorizadas para esta tarea:** solo la release de Trivy elegida y su fichero de checksums, desde
   `github.com/aquasecurity/trivy/releases`, y la base de vulnerabilidades que Trivy baja en la CI. Antes de
   descargar, di nombre, versión, origen y tamaño.

**Hecho cuando:** el job pasa en la CI de tu rama, actionlint, zizmor y shellcheck no se quejan, el `.trivyignore`
está justificado y Marc tiene la lista de hallazgos. Rama sugerida: `chore/ci-trivy`.

## 3. Tarea B · Fase 1 del módulo Vídeo, lo que no necesita Windows

### 3.1 Bloqueo previo: decisiones de Marc

`PLAN-video-fase1.md` no empieza sin **M-D1** (origen de la preview), **M-D2** (perfiles) y **M-D5** (enmiendas de
la spec). **M-D4** (`tauri-plugin-single-instance`) necesita además permiso de descarga. Si este handoff no trae sus
respuestas, pídeselas en la sesión antes de tocar código, con el resumen y la recomendación de la tabla del plan.
Respuestas de Marc (rellenar al disparar la sesión):

- M-D1:
- M-D2:
- M-D5:
- M-D3, M-D4, M-D6–M-D9 (vale la recomendación salvo que diga otra cosa):

### 3.2 Qué tareas del plan van aquí

| Tarea | Aquí | Motivo |
|---|---|---|
| T0 Enmiendas de la spec | Sí | Texto. La R0 del Step 3 la lanzas tú, con un subagente Opus. |
| T1 Esquema del guion y del proyecto | Sí | zod y tests puros. Es la puerta: R0 antes de empezar. |
| T4 Almacén de guiones y proyectos | Sí, con la CI | Lógica de ficheros; sus casos de junctions solo los prueba `windows-latest`. |
| T5 Voz por frases | Sí | ElevenLabs simulado; sin red real. |
| T8 Perfil visual mínimo | Sí | Validación y CSS por tema. |
| T9 Frontera REST del guion | Sí, con la CI | FastAPI y motor real por `APP_BACKEND_VIDEO_CMD`. R1 conjunta de T1+T3+T9 antes de integrar T9. |
| T10, T11 Preview por capacidad; voz, recursos, perfiles y render por REST | Sí, con motores simulados | Lo que lance render real se marca para validar en local. |
| T14 Contrato de pantallas, cliente y modelo | Sí | Si cambia un `data-testid`, se actualiza su E2E en el mismo commit. |
| T15–T20 UI (componentes, estado y tests unitarios) | Sí | Los E2E de Playwright y la comparación visual al píxel se validan en local. |
| T2, T3, T6, T7 | **No** | Necesitan ffmpeg real, render y las comparaciones SSIM de las piezas (referencias solo en la máquina de Marc). |
| T12, T13 | **No** | Rust y Tauri nativos (CSP de la preview, instancia única, diálogos). |
| T21 Aceptación | **No** | App instalada y pasos manuales de Marc. |

Orden y propiedad de ficheros: los de la tabla «Carriles y propiedad» del plan. Ten en cuenta que T9 depende de la
interfaz de T1, y T14 de la tabla REST de T9. Un carril por rama (`feat/<nº>-<slug>`, desde la base de §0), y nunca
dos implementadores sobre los mismos ficheros.

### 3.3 Reglas de ejecución

- TDD como dice el plan: el test que falla primero, después lo mínimo que lo hace pasar.
- **Nada de red real en los tests**: ni DNS, ni SMB, ni salidas fuera de loopback. ElevenLabs, siempre simulado.
- Sin dependencias nuevas en npm, pnpm ni uv. La única candidata es la de M-D4, y con permiso.
- Python con `uv` (`uv sync --extra dev`, `uv run pytest -q`). UI con `pnpm` en `app-ui/`.
- Cada tarea termina con sus tests en verde aquí **y** con la CI de su rama en verde. Si un job de Windows falla,
  reprodúcelo y mídelo antes de cambiar nada.
- Revisión de seguridad por paquete con un subagente Opus `cyber-security-auditor`, y re-revisión acotada a la
  corrección. Critical y High bloquean.
- Plane (proyecto SEO STUDIO, `SEO`) es la fuente de verdad de los issues. Si no tienes conector, deja en el informe
  final la lista de subtareas que hay que crear o actualizar, y no inventes números `SEO-xx`.

### 3.4 Qué queda para la sesión local (no lo hagas)

T2, T3, T6, T7, T12, T13 y T21, los E2E y la comparación visual, el render real y el sandbox, y la preparación de la
prueba piloto. La sesión local integrará tus ramas cuando Marc lo diga.

## 4. Entrega

Por cada tarea: rama, commits, tests (aquí y en la CI), hallazgos de las revisiones y lo que queda pendiente de
validar en local. Al final, un resumen para Marc de ≤ 20 líneas, con el detalle en `docs/` o en un fichero de la rama.
