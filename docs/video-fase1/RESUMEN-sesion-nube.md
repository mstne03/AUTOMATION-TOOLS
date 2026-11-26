# Fase 1 del módulo Vídeo · Resumen de la sesión en la nube (2026-11-07)

Sesión sin Windows ni GPU. Cada rama tiene en `docs/video-fase1/` el informe de su revisión de
seguridad (`seguridad-Tn.md`) y lo que queda pendiente (`pendientes-Tn.md`). No hay PR ni fusiones: todo
espera al sí de Marc.

## Ramas, en orden de integración

| Tarea | Rama | Base | Revisión de seguridad | CI |
|---|---|---|---|---|
| A · Trivy | `chore/ci-trivy` | `feat/video-fase1` | — (cadena de suministro verificada) | verde |
| T0 · Enmiendas de la spec | `feat/t0-enmiendas-spec` | `feat/video-fase1` | R0: aprobada con cambios; re-revisión cerrada | — (texto) |
| T1 · Esquema | `feat/t1-esquema-guion` | T0 | 3 M y 7 L; dos re-revisiones, cerradas | verde |
| T4 · Almacén | `feat/t4-almacen` | T1 | 3 M; re-revisión cerrada con menores | verde |
| T5 · Voz por frases | `feat/t5-voz-frases` | T4 | 1 M (facturación doble); residuales cerrados | verde (voz con ffmpeg real en Windows) |
| T8 · Perfiles | `feat/t8-perfiles` | T5 | sin M; voz por perfil y códigos `sin_clave`/`sin_voz` | ver la CI final |
| T9 · REST del guion | `feat/t9-rest-guion` | T4 (rebasada) | 3 M; R1 T1→T9 aprobada con cambios (N1 y N2 cerrados) | verde |
| T10 · Preview | `feat/t10-preview` | T9 | sin M; Low cerrados | verde |
| T11 · Voz, recursos y render REST | `feat/t11-voz-recursos-render` | T10 + T8 | 2 M y Low, corregidos | ver la CI final |
| T14 · Contrato de UI | `feat/t14-contrato-ui` | T1 | 2 M; dos re-revisiones (credenciales de E2E y carreras del editor) | verde |
| T15 · Guiones en modo Vídeo | `feat/t15-guiones-video` | T14 | 1 M (borrar sin confirmar) | verde |
| T16 · Marco del editor | `feat/t16-editor-marco` | T14 | 3 M (clave de preview viva, I8) | verde |
| T17 · Preview (UI) | `feat/t17-preview` | T16 | 1 M: **no se integra sin T12** (`frame-src`) | verde |
| T18 · Panel lateral | `feat/t18-panel-lateral` | T16 | 4 M; re-revisión cerrada | verde |
| T19 · Timeline | `feat/t19-timeline` | T16 | **1 High** (coste por cifra) → contrato de voz; cerrada | verde |
| T20 · Render, exportar y clave | `feat/t20-render-exportar` | T14 | 1 M (reserva invisible, I11) | ver la CI final |

M = Medium, L = Low. En ninguna rama quedan Critical ni High abiertos.

## Hallazgos de seguridad que más importan

- **Trivy:** compromiso de `trivy-action`, `setup-trivy` y el binario 0.69.4 en marzo de 2026
  (GHSA-69fq-xp46-6x23). La CI usa el binario v0.76.1, de una release inmutable, con su SHA-256 fijado y
  la atestación verificada.
- **Cargo:** `zip` 4.6.1 (una CVE crítica y otra alta) sin alcance real. Están en `.trivyignore` hasta el
  2026-12-07 y hay una tarea aparte para subir `tauri-plugin-updater` a 2.14.1.
- **Facturación de ElevenLabs (T5, T19 y T11):** la confirmación ata el *plan* del motor (voz, modelo y
  textos), no una cifra. El refacturado necesita una casilla explícita. Hay una marca de vuelo contra las
  caídas. Contrato: `contrato-voz.md`.
- **Credenciales en los E2E (T14):** el entorno del sidecar pasa a lista blanca y existe
  `APP_BACKEND_SIN_DOTENV`. Los E2E ya no pueden usar la clave real.
- **I8 (T10, T16 y T17):** puertos de preview reservados en exclusiva; un único dueño del ciclo de vida
  de la clave; el `DELETE` toma el cerrojo; iframe `sandbox="allow-scripts"`.
- **I1 y I2 (T1 y T9):** el esquema rechaza URL, invisibles, bidi y sustitutos sueltos con los mismos
  patrones que `urlsDeRed`. Las regex son lineales.

## Pendiente para la sesión local

- **Tareas de la fase 1 que no son de esta sesión:** T2, T3, T6, T7, T12, T13 y T21, los E2E de
  Playwright, la comparación visual, el render real y el sandbox.
- **Condiciones de integración:**
  - T17 no se integra sin T12, que fija `frame-src` a `47810–47813`;
  - la R1 de T1+T9 se cierra con T3;
  - el barrido al arrancar el motor (R0-6) es de T6: el registro de PID del backend usa `/proc` y en
    Windows no sirve;
  - las tools de recursos y música son de T7.
- **Validar en Windows:**
  - el TIME_WAIT de `SO_EXCLUSIVEADDRUSE`;
  - los casos de junctions;
  - que la app instalada coge la voz del perfil.
- **Configuración y CI:**
  - `chmod +x .githooks/*`: en este clon no eran ejecutables y se lanzaron a mano;
  - añadir el build del motor al job `python` para que los `test_real_*` corran en la CI.
- **Plane** (no autorizado en esta sesión): crear las subtareas de SEO-107 y llevar los Low listados en
  cada `pendientes-Tn.md`. Los commits no llevan `(SEO-xx)`.
