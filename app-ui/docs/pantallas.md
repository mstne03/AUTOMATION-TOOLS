# Pantallas: layout y estados (contrato para los E2E)

No hay Figma. Este documento es la referencia que los tests E2E exigen de forma estricta.
Cada pantalla fija: estructura, `data-testid` de los elementos que se comprueban y los
estados posibles. Lo que no está aquí no se exige.

## Marco común

- Ventana mínima 900×600. Layout de dos columnas: barra lateral fija de 248 px a la
  izquierda (`nav[data-testid=nav]`) y contenido a la derecha (`main`), que ocupa el resto.
- Barra lateral, de arriba abajo: logo y título "SEO Studio" (`h2`); botón `nav-paleta`
  "Buscar o ejecutar… Ctrl K" (abre la paleta de comandos, también con Ctrl K); enlaces con
  icono, en este orden y con estos `data-testid`: `nav-chat` ("Chat"), `nav-publicar`
  ("Publicar"), `nav-canal` ("Canal"), `nav-kb` ("Conocimiento"); el activo lleva
  `aria-current="page"`; lista de conversaciones (`nav-conversaciones`) con el botón
  `conv-nueva` ("Nueva conversación") y un botón `conv-<id>` por conversación (título = primeras
  palabras del primer mensaje; la activa lleva `aria-current="true"`); en el pie, aviso
  `nav-onboarding` ("Completa la configuración") **solo si falta algún paso** (clave de
  Anthropic, client_secret o canal autorizado), tarjeta `nav-job` con el progreso del job activo
  (subida o transcripción; al terminar, un toast con el resultado o el error) y el enlace de
  perfil `nav-ajustes` (canal activo y estado de autorización).
- Onboarding ya no es un enlace fijo del menú: se llega con el aviso, desde Ajustes o al abrir
  la app sin configurar.
- Paleta de comandos (Ctrl K): `paleta` (diálogo) con `paleta-input`; navega a cada pantalla y
  ofrece "Nueva conversación", "Publicar un vídeo" y "Preguntar a la KB…".
- Tema: `data-theme` en `<html>` (`dark` | `light`; sin atributo sigue al sistema), guardado en
  localStorage (`seo-studio.tema`) hasta que el sidecar lo persista.
- Aviso de actualización (`update-banner`) encima del contenido; instalar pide confirmación en un
  diálogo.
- Estados globales (sustituyen al layout entero):
  - `sidecar-arrancando`: texto "Arrancando el sidecar…".
  - `sidecar-error`: texto "No se pudo arrancar el sidecar: <motivo>".
- Si `GET /settings` dice `has_anthropic_key=false` o `has_client_secret=false`, la app
  abre en **Onboarding**; si no, en **Chat**.

## Chat (`/chat`)

Layout vertical dentro de `main`:

1. Cabecera (`chat-header`): a la derecha, indicador de coste `chat-coste` con el texto
   "≈ $X.XXXX · N tokens en caché" acumulado de todos los turnos de la sesión. Vacío hasta
   el primer `done`.
2. Lista de mensajes (`chat-mensajes`), con scroll, que crece hacia abajo y se mantiene
   pegada al final mientras llega el stream.
3. Compositor (`chat-form`): `textarea[data-testid=chat-input]` + botón `chat-enviar`
   (texto "Enviar"). Enter envía, Shift+Enter hace salto de línea. Mientras hay un turno
   en curso el botón pasa a "Cancelar" (`chat-cancelar`) y el textarea queda deshabilitado.

Mensajes:

- Usuario: `article[data-testid=msg-user]` alineado a la derecha, texto plano.
- Agente: `article[data-testid=msg-assistant]`. Contiene bloques en orden:
  - Texto (`bloque-texto`): párrafos; mientras `estado=streaming` y es el último bloque,
    muestra un cursor `▍`.
  - Tool (`bloque-tool`, atributo `data-tool=<nombre>`): tarjeta plegable con cabecera
    "<nombre> · <riesgo>" y el estado (`tool-estado`) con uno de estos textos:
    "ejecutando", "esperando aprobación", "rechazada", "aprobada", "en cola",
    "subiendo N %", "transcribiendo N %", "hecho", "error".
    El detalle plegado muestra `input` como JSON y, cuando hay resultado, `tool-resultado`
    en una zona marcada "Datos" (texto monoespaciado). Si el resultado trae `file`
    (ruta real resuelta), aparece en `tool-ruta` con la etiqueta "Fichero:".
  - **Tarjeta de aprobación** (`approval-card`, atributo `data-risk`), dentro del bloque
    tool cuando `approval.status=pending`:
    - Título "El agente quiere ejecutar <tool>"; chip de riesgo `approval-risk` con el texto
      "escritura" o "DESTRUCTIVA"; `approval-quota` con "Coste de cuota: N (<bucket>)" si
      hay cuota.
    - Tabla `approval-args` con una fila por argumento (clave, valor). `file_path` se
      muestra con la nota "(la ruta real se resuelve al ejecutar)".
    - Botones `approval-aprobar` ("Aprobar") y `approval-rechazar` ("Rechazar").
    - Si `requires_confirm_id`: campo `approval-confirm` con placeholder "Escribe el
      video_id para confirmar"; "Aprobar" está deshabilitado hasta que coincide
      exactamente con `args.video_id`. Fondo rojo (`--danger-bg`). El ID se muestra
      (`approval-video-id`) y se teclea en monoespaciada, y `approval-confirm-estado`
      ("El ID coincide" / "El ID no coincide") avisa en vivo cuando el campo no está vacío.
    - Mientras se envía la decisión, ambos botones deshabilitados.
    - Tras resolverse, la tarjeta desaparece y `tool-estado` pasa a "aprobada" /
      "rechazada". Un rechazo **no** se pinta como error.
  - Error del turno (`turno-error`): caja con "Error: <mensaje>" al final del artículo.
- Separación visual entre datos (resultado de tools, monoespaciado, etiqueta "Datos") y
  texto del modelo (proporcional, sin etiqueta). Esto es lo que el handoff llama
  "distinguir datos de inferencias".

Estados de la pantalla:

- Vacía: `chat-vacio` con el texto "Pregunta al agente o pídele que publique un vídeo."
- Sin clave de Anthropic (`POST /chat` → 409 "Falta la clave"): el turno acaba en
  `turno-error` con ese detalle y un enlace a Ajustes (`chat-ir-ajustes`).
- Turno en curso en otra pestaña (409): igual, `turno-error` con el detalle del sidecar.

## Ajustes (`/ajustes`)

- Formulario `ajustes-form` con secciones en este orden:
  1. Modelo: `select[data-testid=ajustes-model]` con las opciones de `models`.
  2. Clave de Anthropic: estado `ajustes-key-estado` ("Guardada en <secret_store>" o
     "Sin clave"); `input[type=password][data-testid=ajustes-key]` vacío siempre; botón
     `ajustes-key-guardar`; botón `ajustes-key-borrar` solo si hay clave. Tras guardar, el
     campo se vacía y nunca se muestra la clave.
  3. Carpetas permitidas: tabla `ajustes-dirs` con filas `ajustes-dir` (ruta, idioma,
     botón quitar); fila de alta con `ajustes-dir-path`, `ajustes-dir-lang` y
     `ajustes-dir-add`.
  4. Perfil de YouTube: `select[data-testid=ajustes-profile]` con `auth.profiles` más el
     perfil actual (sin tokens guardados la lista viene vacía);
     estado `ajustes-yt-estado` ("Autorizado" / "Sin autorizar"); botón
     `ajustes-yt-reauth` ("Volver a autorizar").
  5. Cuota: tres barras `cuota-<bucket>` con "used / limit".
  6. Información: `state_dir` y `secret_store` en texto.
- Botón `ajustes-guardar` deshabilitado si no hay cambios; mensaje `ajustes-ok`
  "Guardado" durante 3 s tras éxito; `ajustes-error` con el detalle si falla.

## Onboarding (`/onboarding`)

Pasos numerados en una columna (`onboarding-pasos`), cada uno con `data-estado`
`pendiente|hecho`:

1. `paso-clave`: campo de clave de Anthropic + botón "Guardar". Hecho si `has_anthropic_key`.
2. `paso-google`: asistente de Google Cloud en sub-pasos con validador:
   a) crear proyecto y activar YouTube Data API v3 (enlace externo, checkbox manual),
   b) crear credenciales OAuth de tipo "Aplicación de escritorio" y descargar el JSON,
   c) publicar la app OAuth (`google-paso-c`, enlace a Google Auth Platform → Público): en
      "Prueba" los refresh tokens caducan a los 7 días. `google-importar` exige a), b) y c),
   d) importar el JSON: `textarea[data-testid=google-json]` o ruta `google-path`
      + botón `google-importar`. Validador: el JSON debe tener `installed.client_id` y
      `installed.client_secret`; si no, error `google-error` sin enviar nada.
   Hecho si `has_client_secret`.
3. `paso-oauth`: botón `oauth-autorizar` ("Autorizar canal de YouTube"), que llama a
   `POST /youtube/auth` y muestra "Se ha abierto el navegador…" mientras espera. Nota
   `oauth-no-verificada`: explica el aviso de Google "app no verificada" (proyecto propio sin
   verificar) y cómo continuar. Hecho si `auth.authenticated`.
4. `paso-kb`: muestra `GET /kb/estado` (texto). Hecho si la llamada responde.

Botón `onboarding-terminar` ("Ir al chat"), habilitado cuando 1–3 están hechos.

## Publicar vídeo (`/publicar`)

1. `publicar-fichero`: botón `publicar-elegir` ("Elegir vídeo…") que abre el explorador de
   Windows ya situado en `allowed_dirs[0]` y filtrado a vídeo (`mp4, mov, mkv, webm, avi`), y
   rellena `publicar-path` con la ruta elegida. El diálogo lo abre Rust (comando
   `elegir_video` con `tauri-plugin-dialog`), así que el WebView sigue solo con
   `core:default`. `publicar-path` sigue siendo editable: fuera de Tauri (E2E, `pnpm dev`)
   no hay diálogo y la ruta se escribe a mano. Debe empezar por una `allowed_dir`; si no,
   error `publicar-path-error`. El diálogo es comodidad, no control de acceso: el sidecar
   valida la ruta con `resolve_allowed`. Si el diálogo falla, `publicar-elegir-error`.
2. `publicar-transcribir`: botón que crea job `transcribe` y muestra barra
   `publicar-progreso` con "N %"; al terminar, `publicar-transcripcion` con el texto.
3. `publicar-borrador`: botón "Generar borrador" que envía al chat la petición con la
   transcripción; los campos `borrador-title`, `borrador-description`, `borrador-tags`,
   `borrador-privacy`, `borrador-publishAt` son editables.
4. `publicar-subir`: botón que pide al agente subir con los campos actuales; la aprobación
   llega como tarjeta inline (misma tarjeta que el chat) y el progreso en `publicar-progreso`.
   Mientras está deshabilitado, `publicar-subir-motivo` dice por qué ("Falta elegir un
   vídeo…", "Falta el título del borrador.", o que el agente aún está respondiendo).

## Panel de canal (`/canal`)

- `canal-estado`: perfil, autorizado o no, tres barras de cuota.
- `canal-pregunta`: botón que lanza al chat "Analiza mi canal" (reutiliza el chat; el
  análisis del modelo se muestra como texto, los datos de tools como "Datos").

## Base de conocimiento (`/kb`)

- `kb-estado`: texto de `GET /kb/estado` en `pre`.
- `kb-buscar`: `input[data-testid=kb-q]`, `select[data-testid=kb-plataforma]` (todas,
  youtube, tiktok, instagram, linkedin, x), botón `kb-buscar-btn`; resultado en
  `kb-resultado` (`pre`).
- `kb-fuentes`: botón que carga `GET /kb/fuentes` en `kb-fuentes-texto`.
