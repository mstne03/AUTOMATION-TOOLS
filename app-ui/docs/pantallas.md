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

Referencia: artboard "Chat (oscuro)". La pantalla ocupa todo `main` (sin padding) y se divide en:

1. Cabecera (`chat-header`): título de la conversación (h1; "Nueva conversación" hasta el
   primer mensaje; después, las primeras palabras de este), selector de modelo `chat-modelo`
   (menú de elección única con nombre y precio de cada modelo; guarda en `PUT /settings`),
   indicador de coste `chat-coste` con el texto "≈ $X.XXXX · N tokens en caché" acumulado de
   todos los turnos de la conversación (no existe hasta el primer `done`; precios de
   `PRECIOS_MODELO`) y botón `chat-nueva` ("Nueva").
2. Lista de mensajes (`chat-mensajes`), con scroll, hilo centrado de máx. 760 px, pegada al
   final mientras llega el stream.
3. Compositor (`chat-form`): `textarea[data-testid=chat-input]` que crece con el texto hasta
   168 px (luego scroll), botón `chat-adjuntar` (abre el explorador nativo de vídeo e inserta
   la ruta; fuera de Tauri avisa con un toast), interruptor `chat-usar-kb` ("Usar KB · sí/no",
   `role=switch`; apagado, el agente recibe la indicación de no consultar la KB), y a la
   derecha un botón de icono `chat-enviar` (aria-label "Enviar", deshabilitado sin texto) que
   durante un turno pasa a `chat-cancelar` (aria-label "Cancelar"). Enter envía, Shift+Enter
   hace salto de línea; el textarea queda deshabilitado mientras hay un turno en curso.

Mensajes:

- Usuario: `article[data-testid=msg-user]`, burbuja a la derecha, texto plano.
- Agente: `article[data-testid=msg-assistant]` con avatar. Contiene, en el orden en que
  llegaron:
  - Texto (`bloque-texto`) renderizado como Markdown **sin HTML crudo**: párrafos, cabeceras
    (h3–h5), listas, tablas en caja con scroll horizontal (`md-tabla`, con la alineación de las
    columnas), citas, bloques de código, negrita, cursiva y código en línea. Las URLs https
    se pintan como chip "n · dominio ↗" (mismo número para la misma URL en un mensaje) y los
    enlaces `[texto](url)` conservan su texto; ambos abren con `abrir_url`. Una URL que no
    sea https se pinta como texto. Mientras `estado=streaming` y es el último bloque,
    muestra un cursor `▍`.
  - Grupo de pasos (`pasos`): las tools consecutivas forman un único bloque plegable cuyo
    resumen dice "N pasos · <acciones legibles> · X u de cuota". Está abierto mientras alguna
    tool no ha terminado y se pliega al acabar. Cada paso es un `bloque-tool` (atributo
    `data-tool=<nombre técnico>`) con una fila: icono de estado, nombre legible
    ("Subir vídeo a YouTube", mapa en `chat/herramientas.ts`), chip de riesgo en español
    (Escritura / Destructiva; las de lectura no llevan chip; el riesgo sale de
    `GET /youtube/tools`), estado `tool-estado` con uno de estos textos: "ejecutando",
    "esperando aprobación", "rechazada", "aprobada", "en cola", "subiendo N %",
    "transcribiendo N %", "hecho", "error", y la cuota ("1 u"). El detalle plegado muestra el
    nombre técnico, los argumentos en JSON y, cuando hay resultado, `tool-resultado` en una
    zona marcada "Datos" (monoespaciada). Si el resultado trae `file` (ruta real resuelta),
    aparece en `tool-ruta` con la etiqueta "Fichero:".
  - **Tarjeta de aprobación** (`approval-card`, atributo `data-risk`), justo debajo del grupo de
    pasos mientras `approval.status=pending`; recibe el foco al aparecer:
    - Cabecera con icono, título legible de la acción, subtítulo ("Nada se ejecuta hasta que
      apruebes" / "No se puede deshacer", más `approval-quota` "N unidades de cuota (<bucket>)"
      si hay cuota) y chip de riesgo `approval-risk` con el texto "Escritura" o "Destructiva".
    - Tabla `approval-args` con una fila por argumento, con etiquetas en español (Fichero,
      Título, Descripción, Etiquetas, Visibilidad, Programada, ID del vídeo): las etiquetas
      se pintan como chips, la visibilidad traducida, la descripción larga se corta y se
      despliega ("Ver completa" / "Ocultar"), `file_path` en monoespaciada con la nota
      "(la ruta real se resuelve al ejecutar)".
    - "Ver detalles técnicos" (`approval-tecnico`) muestra el nombre de la tool y el JSON
      (`approval-json`); el JSON no se duplica en otro sitio mientras hay aprobación pendiente.
    - Botones `approval-rechazar` ("Rechazar") y `approval-aprobar` ("Aprobar", "Aprobar y
      subir" para subidas, "Borrar definitivamente" para borrados).
    - Si `requires_confirm_id` (destructiva): miniatura (marcador de posición) y el ID en
      monoespaciada (`approval-video-id`); campo `approval-confirm` (placeholder "Escribe el
      video_id para confirmar", monoespaciada); "Aprobar" deshabilitado hasta que coincide
      exactamente con `args.video_id`; `approval-confirm-estado` avisa en vivo ("Faltan N
      caracteres" / "Falta 1 carácter" / "El ID no coincide" / "El ID coincide") cuando el campo
      no está vacío. Fondo rojo apagado y borde rojo.
    - Mientras se envía la decisión, ambos botones deshabilitados.
    - Tras resolverse, la tarjeta desaparece y `tool-estado` pasa a "aprobada" /
      "rechazada". Un rechazo **no** se pinta como error.
  - Error del turno (`turno-error`, `role=alert`): caja con "Error: <mensaje>" al final del
    artículo.
- Separación visual entre datos (resultado de tools, monoespaciado, etiqueta "Datos") y
  texto del modelo (proporcional, sin etiqueta). Esto es lo que el handoff llama
  "distinguir datos de inferencias".

Estados de la pantalla:

- Vacía: `chat-vacio` con el texto "Pregunta al agente o pídele que publique un vídeo."
- Sin clave de Anthropic (`POST /chat` → 409 "Falta la clave"): el turno acaba en
  `turno-error` con ese detalle y un enlace a Ajustes (`chat-ir-ajustes`).
- Turno en curso en otra pestaña (409): igual, `turno-error` con el detalle del sidecar.

## Ajustes (`/ajustes`)

Referencia: artboard "Ajustes (claro)". Pantalla a sangre (`ajustes-form`). **Guardado
automático**: no hay botón "Guardar"; cada cambio se envía al sidecar al momento y avisa con un
toast ("Modelo guardado", "Carpeta añadida"…, `role=status`); si falla, toast de error y
`ajustes-error`.

- Subnavegación `ajustes-subnav` (botones `ajustes-nav-general|canales|carpetas|clave|avanzado`,
  el activo con `aria-current="true"`) que desplaza a cada sección.
- **General**: modelo como tarjetas de radio (`ajustes-model` = radiogroup; una tarjeta
  `ajustes-model-<id>` por modelo de `models`, con nombre, descripción y precio de la tabla
  única de `PRECIOS_MODELO`); apariencia `ajustes-tema` (Sistema / Claro / Oscuro; se aplica como
  `data-theme` y se guarda en localStorage).
- **Canales de YouTube**: botón `ajustes-yt-anadir` ("Añadir canal") que abre un diálogo con el
  nombre del perfil (minúsculas, números, `-`, `_`; máx. 32; `ajustes-yt-nombre`) y, al aceptar
  (`ajustes-yt-anadir-ok`), lanza el OAuth de ese perfil (`POST /youtube/auth`) y lo deja en uso
  (`PUT /settings`). Lista `ajustes-profile` con una tarjeta `ajustes-profile-<nombre>` por perfil
  (`auth.profiles` más el actual; el actual con `aria-current="true"`): el actual muestra
  `ajustes-yt-estado` (chip "Autorizado" / "Sin autorizar") y `ajustes-yt-reauth` ("Volver a
  autorizar"); los demás, `ajustes-yt-usar-<nombre>` ("Usar este").
- **Carpetas permitidas**: `ajustes-dir-elegir` ("Elegir carpeta…", explorador nativo con el
  comando Rust `elegir_carpeta`; fuera de Tauri no hace nada), lista `ajustes-dirs` con una fila
  `ajustes-dir` por carpeta (ruta monoespaciada, selector de idioma Español / Inglés / Detectar,
  botón de icono "Quitar la carpeta <ruta>"), y alta a mano: `ajustes-dir-path`,
  `ajustes-dir-lang` (select) y `ajustes-dir-add`. Una carpeta repetida se rechaza.
- **Clave de Anthropic**: `ajustes-key-estado` ("sk-ant-•••• · Guardada en <secret_store>" o
  "Sin clave"). Sin clave, o tras "Reemplazar" (`ajustes-key-reemplazar`), aparece
  `input[type=password][data-testid=ajustes-key]` (vacío siempre) con `ajustes-key-guardar`; con
  clave guardada el campo no existe. Tras guardar nunca se muestra la clave. `ajustes-key-borrar`
  ("Borrar") pide confirmación en un diálogo.
- **Avanzado**: cuota de YouTube de hoy (`cuota-<bucket>`, "154 de 10.000"), información
  (directorio de estado y almacén de secretos con su nombre legible: "Administrador de
  credenciales de Windows") y `ajustes-asistente` ("Abrir el asistente" → Onboarding).

## Onboarding (`/onboarding`)

Asistente de bienvenida **a ancho completo y sin barra lateral** (la ruta queda fuera del marco
común), con un paso visible cada vez. Se llega con el aviso "Completa la configuración" de la barra,
al abrir la app sin configurar o desde Ajustes › Avanzado › "Asistente de configuración".

- Cabecera (`onboarding`): logo, h1 "Primeros pasos", `onboarding-progreso` ("Paso N de 4"), barra de
  progreso (pasos hechos / 4) y migas `onboarding-ir-<paso>` (Clave de Anthropic, Google Cloud,
  Autorizar canal, Base de conocimiento): solo se puede ir a pasos ya alcanzados (hasta el primer
  pendiente; con 1–3 hechos, también al cuarto).
- `onboarding-pasos` (`ol`) contiene los cuatro `li` en este orden, cada uno con `data-estado`
  `pendiente|hecho`; solo el paso actual es visible (los demás llevan `hidden`). Mientras el usuario
  no navegue, el asistente avanza solo al primer paso pendiente (o abre en el primero si todo está
  hecho). Debajo: `onboarding-atras`, `onboarding-continuar` (habilitado si el paso actual está
  hecho; no existe en el último) y `onboarding-terminar` ("Ir al chat", habilitado cuando 1–3 están
  hechos; va al chat con `state.bienvenida`).
1. `paso-clave`: `clave-input` (password) y `clave-guardar` ("Validar y guardar"). Antes de guardar
   se valida con Anthropic (`POST /settings/validate-key`, que hace un `GET /v1/models` sin coste):
   una clave que Anthropic no reconoce muestra `clave-error` y no se guarda. Hecho si
   `has_anthropic_key`.
2. `paso-google`: checklist informativa (`google-paso-a|b|c`: crear proyecto y activar YouTube Data
   API v3, crear credenciales de "Aplicación de escritorio", publicar la app OAuth; en "Prueba" los
   refresh tokens caducan a los 7 días) que **no bloquea** "Importar". Zona `google-soltar` para
   soltar el `client_secret.json` (o `google-fichero`, selector del navegador) y `google-elegir`
   ("Elegir fichero…", diálogo nativo con el comando Rust `elegir_client_secret`); también
   `textarea[data-testid=google-json]` y la ruta `google-path`, y `google-importar`. Validador: el
   JSON debe tener `installed.client_id` y `installed.client_secret`; si no, `google-error` sin
   enviar nada. Los enlaces abren con `abrir_url`. Hecho si `has_client_secret`.
3. `paso-oauth`: `oauth-autorizar` ("Autorizar canal de YouTube", deshabilitado hasta tener las
   credenciales), que llama a `POST /youtube/auth` y muestra "Se ha abierto el navegador…" mientras
   espera. Nota `oauth-no-verificada`: explica el aviso de Google "app no verificada". Hecho si
   `auth.authenticated`.
4. `paso-kb`: muestra `GET /kb/estado` (`kb-estado-texto`). Hecho si la llamada responde.

Al terminar, el chat muestra `chat-bienvenida` ("¡Todo listo!") con tres preguntas sugeridas
`chat-sugerencia-1..3` que se envían al agente.

## Publicar vídeo (`/publicar`)

Referencia: artboard "Publicar vídeo (oscuro)". Pantalla a sangre: cabecera, cuerpo en dos
columnas (formulario a la izquierda, vista previa y comprobaciones a la derecha) y barra
inferior fija. Todo el estado (ruta, transcripción, borrador, job) vive en un store y sobrevive
a cambiar de pantalla.

- Cabecera: h1 "Publicar vídeo" y el asistente `publicar-pasos` (`ol`): `publicar-paso-1..4`
  (Vídeo, Transcripción, Borrador, Revisar y subir) con `data-estado` = `hecho` | `actual` |
  `pendiente` y `aria-current="step"` en el actual. Se deriva de los datos (la transcripción es
  opcional: se da por pasada en cuanto hay título). Los pasos hechos son botones que llevan el
  foco a su campo.
- `publicar-fichero`: tarjeta del vídeo (miniatura de marcador, nombre y carpeta; no se muestran
  tamaño ni duración porque el sidecar no los da), botón `publicar-elegir` ("Elegir vídeo…" /
  "Cambiar…") que abre el explorador de Windows situado en `allowed_dirs[0]` y filtrado a vídeo
  (`mp4, mov, mkv, webm, avi`; comando Rust `elegir_video`) y rellena `publicar-path` (campo
  monoespaciado, editable: fuera de Tauri se escribe a mano). Debe empezar por una `allowed_dir`;
  si no, `publicar-path-error`. El diálogo es comodidad, no control de acceso: el sidecar valida
  con `resolve_allowed`. Si el diálogo falla, `publicar-elegir-error`.
- Transcripción (bloque plegable, abierto mientras no hay transcripción): `publicar-transcribir`
  crea un job `transcribe`; `publicar-progreso` con la barra y "N %"; al terminar,
  `publicar-transcripcion` con el texto (o `publicar-sin-voz`).
- `publicar-borrador`: botón `borrador-generar` ("Generar con el agente" / "Regenerar con el
  agente") y los campos `borrador-title` (contador n / 100 caracteres), `borrador-description`
  (n / 5000 **bytes** UTF-8), `borrador-tags` (campo de `TagInput`; contador n / 500 contando
  comas y las comillas de las etiquetas con espacios), `borrador-privacy` (SegmentedControl:
  Privado / Oculto / Público) y `borrador-publishAt` (datetime-local con la zona horaria). Al
  fijar una fecha la visibilidad pasa a Privado y se bloquean las otras; una fecha pasada
  bloquea la subida. Límites verificados contra la documentación de YouTube; `<` y `>` no se
  admiten en título, descripción ni etiquetas.
- Columna derecha: vista previa "Así se verá en YouTube" (`publicar-previa-titulo`) y
  `publicar-comprobaciones` (`li[data-nivel]` = `ok` | `aviso` | `error` | `info`): título,
  fichero en carpeta permitida, descripción (aviso por marcadores sin rellenar como
  `[ENLACE A …]`), etiquetas, fecha y cuota de subidas del día. Los de nivel `error` bloquean la
  subida; los `aviso` no.
- Barra inferior: a la izquierda `publicar-subir-motivo` con el motivo que impide subir ("Falta
  elegir un vídeo…", "Falta el título del borrador.", el error de límites, o que el agente aún
  está respondiendo) o, si se puede, el estado del borrador; "Descartar" (con confirmación:
  vacía ruta, transcripción, borrador y conversación) y `publicar-subir` ("Revisar y subir").
- La propuesta de subida del agente se abre en un diálogo no descartable "Revisar y subir"
  (`publicar-aprobacion`) con la tarjeta de aprobación del chat y, debajo, o bien
  `publicar-coincide` ("Coincide con tu borrador") o `publicar-diferencias` con cada campo
  que difiere (fichero, título, descripción, etiquetas, visibilidad, fecha); con diferencias, "Aprobar"
  queda bloqueado hasta marcar `publicar-acepto`. La respuesta del agente (estado de la tool,
  progreso de la subida, errores) se ve en `publicar-turnos`, sin tarjetas de aprobación.

## Panel de canal (`/canal`)

Referencia: artboard "Panel de canal (oscuro)". Pantalla a sangre con padding propio. Datos de
`GET /youtube/channel` (caché de 10 min en el sidecar; solo se pide si el canal está autorizado).

- `canal-estado` (cabecera): avatar con la inicial (las miniaturas de YouTube no se cargan: la CSP
  de la app solo admite `img-src 'self' data:`; decisión pendiente, ver abajo), h1 con el
  `@handle` (o el nombre), "Perfil <perfil> · datos de hace N min", chip "Autorizado" /
  "Sin autorizar", `canal-cambiar` ("Cambiar de canal", va a Ajustes) y `canal-pregunta`
  ("Analizar con el agente"; lanza al chat "Analiza mi canal"; deshabilitado sin autorizar).
- Cuatro tarjetas de métricas (`canal-metrica-suscriptores`, `-visualizaciones`, `-horas`,
  `-retencion`): suscriptores con la variación neta de 28 días, visualizaciones de 28 días
  con el % frente a los 28 días previos, horas vistas y retención media (Analytics API: sin
  cuota de la Data API). Si Analytics no está disponible, el resto del panel se pinta y las
  tarjetas dicen "Analytics no disponible".
- `canal-videos`: tabla de los últimos 10 vídeos (`canal-video-<id>`): título, fecha, "Short",
  ID en monoespaciada, chip de estado (Privado / Público / Oculto / Programado) y vistas;
  acción por fila `canal-video-accion-<id>`: "Analizar" (públicos) o "Editar" (privados y
  programados), que abren el chat con un mensaje inicial. `canal-actualizar` vuelve a pedirlo.
- `canal-cuota` (columna derecha): "Cuota de hoy" con la hora local de reinicio (medianoche del
  Pacífico) y una fila `cuota-<cubo>` por cubo con nombre legible ("Unidades", "Búsquedas",
  "Subidas"), "154 de 10.000" con separador de miles y `data-nivel` = `normal` | `alto` (≥ 80 %)
  | `critico` (≥ 95 %) que cambia el color de la barra.
- Tres preguntas sugeridas `canal-sugerencia-1..3` (abren el chat con esa pregunta).
- Estados: sin autorizar (estado vacío, sin consultar el canal), cargando, error del sidecar
  (`canal-error`, `role=alert`).

## Base de conocimiento (`/kb`)

Sin artboard propio: tarjetas, chips y estado vacío del catálogo. Pantalla a sangre. Los datos
estructurados vienen de `GET /kb/buscar` y `GET /kb/fuentes` con `?formato=json` (sin él devuelven
el texto que lee el agente). Cada elemento lleva `origen` ("publica" | "privada").

- `kb-snapshot`: tarjeta "Estado" con versión (monoespaciada), fecha de instalación, documentos,
  fragmentos y chip de firma ("Verificada al instalar" si hay snapshot instalado), el último error de
  actualización si lo hubo, y `kb-actualizar` ("Buscar actualización", `POST /kb/update`, avisa con un
  toast). `kb-estado` (`pre`, dentro de "Ver estado detallado") es el texto de `GET /kb/estado`.
- Búsqueda: `kb-buscar` (formulario) con `input[data-testid=kb-q]`,
  `select[data-testid=kb-plataforma]` (todas, youtube, tiktok, instagram, linkedin, x) y botón
  `kb-buscar-btn`; pide `GET /kb/buscar?…&k=8&formato=json`. Filtro de origen `kb-origen`
  (radiogroup Todos / Pública / KB privada, aplicado en el cliente). Resultados en `kb-resultado`
  con `kb-resultado-total` ("N resultados") y una `kb-tarjeta` por bloque: título (enlace "↗" que
  abre con `abrir_url` si es https), chips de plataforma y origen, fecha, fragmento recortado
  alrededor de lo más parecido a la consulta (sin la cabecera interna de los chunks) y dominio. Sin
  resultados, estado vacío.
- Fuentes: botón `kb-fuentes` ("Ver fuentes") que carga `GET /kb/fuentes?formato=json` en
  `kb-fuentes-lista` ("N fuentes" y una `kb-fuente` por documento, con los mismos chips).
- Mi base privada (`kb-privada`): lista `kb-privada-lista` de `GET /kb/privada/fuentes` (una
  `kb-privada-item` por documento, con botón `kb-privada-borrar` que pide confirmación y llama a
  `DELETE /kb/privada/fuentes`), alta por URL http(s) (`kb-privada-url`, `kb-privada-add`; valida
  el formato, avisa con un toast y refresca la lista) y, si está vacía, estado vacío con "Añadir
  URL". Solo se añaden URLs; las notas y los documentos locales entran por las tools del agente.

## Regresión visual

`e2e/visual.spec.ts` captura `chat`, `publicar`, `canal`, `kb`, `ajustes`, `onboarding` y el catálogo
(`/#/catalogo`) en claro y oscuro, a 1200×800 y 900×600 (el catálogo muestra los dos temas, así que
solo se captura una vez por tamaño). Los datos que varían (ajustes, canal, estado de la KB) se
simulan y el reloj se fija; las referencias están en `e2e/__capturas__/`.

