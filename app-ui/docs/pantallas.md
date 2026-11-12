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
  ("Publicar"), `nav-guiones` ("Guiones"), `nav-video` ("Vídeo"), `nav-canal` ("Canal"), `nav-kb` ("Conocimiento");
  el activo lleva
  `aria-current="page"`; lista de conversaciones (`nav-conversaciones`) con el botón
  `conv-nueva` ("Nueva conversación") y un botón `conv-<id>` por conversación (título = primeras
  palabras del primer mensaje; la activa lleva `aria-current="true"`). Los chats se guardan en el
  sidecar (`GET /conversations`) y siguen ahí al reabrir la app: los guardados tienen id
  `chat:<id del sidecar>` y van delante de los de la sesión, que arranca en un chat vacío. Solo se
  ven los chats del canal (perfil) en uso, más los aún sin enviar; al cambiar de canal, si el chat
  abierto era de otro, pasa a uno vacío. Cada fila tiene `conv-borrar-<id>` (icono, visible al
  pasar por encima, con el foco o en la activa; "Borrar la conversación «<título>»"), que pide
  confirmación ("¿Borrar la conversación?", "Borrar") y la borra del sidecar
  (`DELETE /conversations/{id}`); si era la abierta, se abre otra del canal o una vacía. En el pie, aviso
  `nav-onboarding` ("Completa la configuración") **solo si falta algún paso** (clave de
  Anthropic, client_secret o canal autorizado), tarjeta `nav-job` con el progreso del job activo
  (subida o transcripción; al terminar, un toast con el resultado o el error) y el enlace de
  perfil `nav-ajustes` (canal activo y estado de autorización): `nav-canal-activo` con el título
  del canal de YouTube del perfil en uso (`auth.channel.title`) o, si no se conoce, el nombre del perfil.
- Onboarding ya no es un enlace fijo del menú: se llega con el aviso, desde Ajustes o al abrir
  la app sin configurar.
- Paleta de comandos (Ctrl K): `paleta` (diálogo) con `paleta-input`; navega a cada pantalla y
  ofrece "Abrir Vídeo" (`/video`), "Nueva conversación", "Publicar un vídeo", "Escribir un guion" (Guiones en el modo
  Escribir) y "Preguntar a la KB…".
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
2. Lista de mensajes (`chat-mensajes`), con scroll, hilo centrado de máx. 760 px. Mientras llega
   el stream sigue el final solo si el usuario ya estaba abajo (margen de 32 px): si sube, la
   posición no se mueve y aparece `chat-ir-al-final` («Ir al final», flotante sobre el borde
   inferior de la lista), que baja y reanuda el seguimiento; volver abajo con la rueda también lo
   reanuda. Enviar un mensaje o abrir otra conversación lleva al final.
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
    "esperando aprobación", "rechazada", "aprobada", "cancelada", "en cola", "subiendo N %",
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
    - Si el turno termina (error, cancelación o el stream se corta) con la propuesta aún
      pendiente, el sidecar ya la ha cancelado: la tarjeta desaparece, `tool-estado` pasa a
      "cancelada" y en Publicar se cierra el diálogo "Revisar y subir".
  - Error del turno (`turno-error`, `role=alert`): caja con "Error: <mensaje>" al final del
    artículo. Si el stream se corta sin `done` ni `error`, el turno acaba en error con "La
    conexión con el sidecar se cortó antes de terminar la respuesta.".
- Separación visual entre datos (resultado de tools, monoespaciado, etiqueta "Datos") y
  texto del modelo (proporcional, sin etiqueta). Esto es lo que el handoff llama
  "distinguir datos de inferencias".

Estados de la pantalla:

- Vacía: `chat-vacio` con el texto "Pregunta al agente o pídele que publique un vídeo."
- Chat guardado de otra sesión: mientras se descarga, `chat-cargando` ("Cargando la conversación…");
  después se pinta reproduciendo sus eventos con el mismo reducer que el stream. Una respuesta que
  se cortó (se cerró la app a mitad) acaba en `turno-error` ("La respuesta se interrumpió…") y sus
  propuestas quedan canceladas.
- Sin clave de Anthropic (`POST /chat` → 409 "Falta la clave"): el turno acaba en
  `turno-error` con ese detalle y un enlace a Ajustes (`chat-ir-ajustes`).
- Turno en curso en otra pestaña (409): igual, `turno-error` con el detalle del sidecar.

## Ajustes (`/ajustes`)

Referencia: artboard "Ajustes (claro)". Pantalla a sangre (`ajustes-form`). **Guardado
automático**: no hay botón "Guardar"; cada cambio se envía al sidecar al momento y avisa con un
toast ("Modelo guardado", "Carpeta añadida"…, `role=status`); si falla, toast de error y
`ajustes-error`.

- Subnavegación `ajustes-subnav` (botones `ajustes-nav-general|canales|carpetas|clave|video|avanzado`, seis botones,
  el activo con `aria-current="true"`) que desplaza a cada sección.
- **General**: modelo como tarjetas de radio (`ajustes-model` = radiogroup; una tarjeta
  `ajustes-model-<id>` por modelo de `models`, con nombre, descripción y precio de la tabla
  única de `PRECIOS_MODELO`); apariencia `ajustes-tema` (Sistema / Claro / Oscuro; se aplica como
  `data-theme` y se guarda en localStorage).
- **Canales de YouTube**: un solo proyecto de Google Cloud (client_secret.json) para toda la app y
  un token por canal; todos los canales comparten la cuota diaria del proyecto. Tarjeta
  `ajustes-google-proyecto` encima de la lista: "<project_id> · cliente <client_id enmascarado>"
  (`google_project` de `GET /settings`) o "Sin proyecto…"; `ajustes-google-sustituir`
  ("Sustituir…", o "Importar client_secret.json" sin proyecto) abre un diálogo con el mismo
  importador que el Onboarding (`google-*`); si el fichero es de otro proyecto y hay canales
  autorizados, el sidecar responde 409 y se pide confirmación ("¿Sustituir el proyecto de
  Google?", con el detalle del sidecar y el botón "Sustituir y desautorizar", que repite con
  `replace: true`); al terminar, un aviso con los perfiles que hay que volver a autorizar.
  `ajustes-google-eliminar` ("Quitar", solo con proyecto) pide confirmación ("Quitar y
  desautorizar", `DELETE /settings/client-secret`). Botón `ajustes-yt-anadir` ("Añadir canal")
  que abre un diálogo con el
  nombre del perfil (minúsculas, números, `-`, `_`; máx. 32; `ajustes-yt-nombre`) y, al aceptar
  (`ajustes-yt-anadir-ok`), lanza el OAuth de ese perfil (`POST /youtube/auth`) y lo deja en uso
  (`PUT /settings`). Sin proyecto, el diálogo muestra `ajustes-yt-sin-proyecto` con "Importar
  client_secret.json" (abre el importador) y `ajustes-yt-anadir-ok` queda deshabilitado. Mientras
  espera al navegador, `ajustes-yt-ayuda-google` explica qué hacer si Google bloquea la cuenta
  (no es usuario de prueba: añadirla o publicar la app); si la autorización falla (no por
  cancelarla), `ajustes-yt-error-ayuda` enlaza a las credenciales de Google Cloud y ofrece
  "Sustituir client_secret.json". Si el canal autorizado ya estaba en otro
  perfil (`duplicated_in`), el aviso lo dice. Lista `ajustes-profile` con una tarjeta
  `ajustes-profile-<nombre>` por perfil (`auth.profiles` más el actual; el actual con
  `aria-current="true"`), con `ajustes-canal-<nombre>` (título del canal de `auth.channels`, o el
  nombre del perfil) y debajo "Perfil <nombre> · @handle · En uso|Guardado". El actual muestra
  `ajustes-yt-estado` (chip "Autorizado" / "Sin autorizar") y `ajustes-yt-reauth` ("Volver a
  autorizar"; mientras espera al navegador, "Se ha abierto el navegador…" y al lado
  `ajustes-yt-reauth-cancelar`); los demás, `ajustes-yt-usar-<nombre>` ("Usar este").
  Mientras el OAuth espera al navegador, "Cancelar" o Escape cierran el diálogo de alta y cortan
  la autorización (`POST /youtube/auth/cancel`); un alta cancelada deja el perfil anterior en uso.
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
- **Motor de vídeo** (`ajustes-video`, entre Clave de Anthropic y Avanzado): descarga a petición del
  navegador del render (Chrome for Testing) y modo de render. Todo por el cliente HTTP del sidecar
  (`GET /video/navegador` con sondeo de 1 s solo mientras la fase es activa; `POST
  /video/navegador/descarga`; `GET /video/capacidades` **solo con el navegador `listo`**, nunca al
  abrir Ajustes: sin caché el motor hace una prueba de GPU de minutos). Nunca se descarga solo (I14):
  cargar o recargar Ajustes no hace ningún POST. Los textos del backend (`error`, `detail`) se pintan
  como texto, sin rutas del sistema ni hashes. **No hay selector de navegador, ruta editable, `input
  file` ni enlace a Chrome/Edge del sistema (I11).**
  - `ajustes-video-aviso`: «El render usa Chrome for Testing <versión> (~120 MB), que se descarga
    una sola vez de storage.googleapis.com, solo cuando tú lo pides, y se verifica antes de usarlo.»
  - `ajustes-video-estado` (chip): `ausente` «No descargado»; `descargando` «Descargando…»;
    `verificando` «Verificando…»; `extrayendo` «Instalando…»; `listo` «Listo» (success); `error`
    «Error» (destructive).
  - `ajustes-video-descargar` (primario): solo en `ausente` («Descargar el navegador del render»),
    `error` («Reintentar la descarga») y `listo` con el navegador corrupto («Volver a descargar»,
    M9). Con `loading` mientras el POST está pendiente. Un 409 («Ya hay una descarga…») o una
    recarga con la descarga en marcha retoman el progreso: no se ofrece otra descarga.
  - `ajustes-video-progreso` (barra, solo en fases activas): `descargando` con valor
    `descargado/tamano` y «48 de 120 MB»; `verificando` y `extrayendo` indeterminada.
  - `ajustes-video-error` (`role="alert"`): `error` del GET, fallo del POST, o navegador `listo`
    pero corrupto (`/video/capacidades` falla con otro error que «no está instalado», o responde
    200 sin `chrome` y con `gpu.detalle`); en ese caso se ofrece «Volver a descargar».
  - `ajustes-video-sin-motor`: «El módulo de vídeo no está instalado en esta versión.» si el POST o
    `/video/capacidades` dan 503 «no está instalado»; no hay botón de descarga.
  - `ajustes-render-modo` (radiogroup «Modo de render»): `ajustes-render-modo-auto` (Automático,
    por defecto: «Dos pasadas; funciona en cualquier equipo»: hoy equivale a Compatible),
    `ajustes-render-modo-rapido` («Una sola pasada con la GPU») y `ajustes-render-modo-compatible`
    («Dos pasadas; funciona en cualquier equipo»). «Rápido» está deshabilitado salvo que
    `capacidades.codificadores` incluya alguno distinto de `h264_mf` (software, M7), con
    `ajustes-render-rapido-aviso`: navegador no listo «Descarga el navegador del render para
    comprobar los codificadores»; listo y pendiente «Comprobando…»; error de capacidades (o
    navegador corrupto) «No se han podido comprobar los codificadores»; sin GPU «No hay
    codificador de GPU: se usará Compatible». Si «Rápido» está guardado pero no hay GPU, no se
    marca: se marca el modo efectivo (Compatible) y lo guardado no se toca. Guardado automático en
    `localStorage` (`seo-studio.render-modo`; un valor inválido vale «auto») con toast «Modo de
    render guardado». El modo ya se aplica al render: el diálogo de render envía el modo efectivo
    (Rápido sin GPU se envía como Compatible). `ajustes-render-modo-nota` se retiró en la Task 20.
  - **Clave de ElevenLabs** (Task 20): `ajustes-eleven-estado` (chip «Configurada» success /
    «No configurada»: es lo único que la UI sabe, por `has_elevenlabs_key`), `ajustes-eleven-clave`
    (`input` password, **vacío siempre**: la clave solo se escribe, nunca se lee ni se pinta de
    vuelta; se vacía al enviar, aunque la validación tarde), `ajustes-eleven-guardar` (primero
    `POST /settings/validate-elevenlabs-key`, que no gasta; si es válida, `PUT /settings
    { elevenlabs_api_key }`; una clave inválida no se guarda), `ajustes-eleven-borrar` (solo con clave
    configurada; `PUT` con cadena vacía) y `ajustes-eleven-error` (`role="alert"`: texto del servidor
    sin rutas y sin la clave). La clave nunca va a `localStorage`, al estado persistido ni a la caché
    de consultas.
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
  no navegue, el asistente avanza solo al primer paso pendiente; con 1–3 hechos abre en el último
  (`paso-kb`, con `onboarding-listo` "Todo listo…"), nunca en un paso ya hecho. Completar un paso
  (clave, credenciales o autorización) devuelve el asistente a esa regla aunque el usuario hubiera
  navegado a mano. Debajo: `onboarding-atras`, `onboarding-continuar` (habilitado si el paso actual está
  hecho; no existe en el último) y `onboarding-terminar`, siempre habilitado para que un paso que no
  se puede completar no deje al usuario encerrado: "Ir al chat" con 1–3 hechos (va al chat con
  `state.bienvenida`) y "Terminar más tarde" si falta alguno (va al chat sin bienvenida; el aviso
  `nav-onboarding` recuerda lo que falta).
1. `paso-clave`: `clave-input` (password) y `clave-guardar` ("Validar y guardar"). Antes de guardar
   se valida con Anthropic (`POST /settings/validate-key`, que hace un `GET /v1/models` sin coste):
   una clave que Anthropic no reconoce muestra `clave-error` y no se guarda. Hecho si
   `has_anthropic_key`.
2. `paso-google`: checklist informativa (`google-paso-a|b|c`: crear proyecto y activar YouTube Data
   API v3, crear credenciales de "Aplicación de escritorio", publicar la app OAuth; en "Prueba" los
   refresh tokens caducan a los 7 días) que **no bloquea** "Importar". Zona `google-soltar` para
   soltar el `client_secret.json`. **Elegir o soltar el fichero lo importa en el acto**: no existe
   un estado "elegido pero sin importar" (SEO-106). Un solo selector: en la app, `google-elegir`
   ("Elegir fichero…", diálogo nativo con el comando Rust `elegir_client_secret`, que manda la ruta
   al sidecar); fuera de Tauri, `google-fichero` (selector del navegador, que manda el JSON). Tras
   importar, `google-importado` ("<fichero> importado · proyecto <project_id> · cliente <client_id
   enmascarado>"). Con un proyecto activo, `google-activo` ("Proyecto activo: <project_id> ·
   cliente <…>. Importar otro lo sustituye."). Debajo, para pegar el JSON
   (`textarea[data-testid=google-json]`) o escribir la ruta (`google-path`), un único
   `google-importar` común a los dos; mientras haya texto sin importar, `google-pendiente` avisa de
   que sigue activo el proyecto anterior (o de que no hay ninguno) y `onboarding-continuar` queda
   deshabilitado. Validador: el JSON debe tener `installed.client_id` y `installed.client_secret`;
   si no, `google-error` sin enviar nada (también al elegir o soltar un fichero no válido). Los
   enlaces abren con `abrir_url`. Hecho si `has_client_secret`. El importador es el mismo de
   Ajustes (con su confirmación al sustituir un proyecto con canales autorizados).
3. `paso-oauth`: `oauth-autorizar` ("Autorizar canal de YouTube", deshabilitado hasta tener las
   credenciales), que llama a `POST /youtube/auth` y muestra "Se ha abierto el navegador…" mientras
   espera, con `oauth-cancelar` ("Cancelar", `POST /youtube/auth/cancel`) al lado y
   `oauth-ayuda-google` (qué hacer si Google bloquea la cuenta); el fallo o la cancelación se
   muestran en `oauth-error`, con `oauth-ir-google` ("Revisar el proyecto de Google") que vuelve
   al paso 2. Nota `oauth-no-verificada`: explica el aviso de
   Google "app no verificada". Hecho si `auth.authenticated` (el sidecar renueva el token de acceso
   caducado con el de refresco antes de responder). Hecho: `oauth-estado` ("Canal autorizado ·
   <título> (@handle)" con `auth.channel`, o "Canal autorizado · perfil <perfil>" si no se conoce) y el botón pasa a "Volver a autorizar" (secundario, `reauthorize: true`). No
   hecho con `auth.reason` (Google rechazó la autorización guardada): `oauth-motivo` con ese texto.
   Autorizar con éxito muestra el aviso "Canal autorizado".
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

## Guiones (`/guiones`)

Sin artboard propio: mismo esqueleto que Publicar (cabecera, cuerpo en dos columnas con paneles a la
derecha) y componentes del catálogo. Pantalla a sangre. Diseño y porqués en `SPEC-guiones.md` (raíz
del repo). Todo el estado de cada modo vive en un store (`state/guiones.ts`) y sobrevive a cambiar
de modo o de pantalla; cada modo tiene su propia conversación con el agente (`guiones:<modo>`, no se
guarda en el sidecar).

- Cabecera: h1 "Guiones" y `guiones-modos` (SegmentedControl, `role=radiogroup` "Modo") con las
  opciones Escribir / Revisar / Diagnosticar (`role=radio`, la activa con `aria-checked="true"`).
  Al entrar, Escribir. Solo se pinta el modo activo.
- En Escribir y Revisar el formato es un SegmentedControl "Formato" (Vídeo largo / Short;
  `escribir-formato`, `revisar-formato`). El JSON del agente se valida al terminar el turno; si no
  se puede leer, `guion-json-error` ("No se pudo leer la respuesta del agente como guion. Abajo
  tienes su texto completo.") y el resultado anterior no cambia. Las respuestas del agente se ven
  debajo (`escribir-turnos`, `revisar-turnos`, `diag-turnos`) con la misma vista que el chat,
  aprobaciones incluidas. Cada resultado tiene "Empezar de nuevo" (vacía el modo y su conversación).
- `guion-fuentes` (panel derecho): enlaces de `fuentes` del JSON con `EnlaceExterno`; solo se
  conservan las URLs https. Oculto si no hay ninguna.

### Escribir

- `escribir-form`: `escribir-tema` (obligatorio, "¿De qué va el vídeo?"), `escribir-formato`,
  `escribir-duracion` (minutos, mínimo 0,25, paso 0,25; 8 en vídeo largo y 0,5 en Short al cambiar
  de formato mientras el usuario no la haya tocado) y `escribir-publico` (opcional). Botón
  `escribir-generar` ("Generar guion"; "Generar otro" con resultado; "Generando…" durante el
  turno), deshabilitado con `escribir-motivo` ("Falta el tema.", "La duración debe ser mayor que
  cero." o "Espera a que el agente termine.").
- `escribir-resultado`: `escribir-ganchos` (radiogroup "Gancho") con un `gancho-opcion` por gancho:
  radio, chip `gancho-tipo` y el texto editable; el primero elegido al llegar el guion.
  `escribir-bloques` (`ol`) con un `bloque-guion` por bloque: `bloque-titulo` ("Título"),
  `bloque-segundos`, `bloque-contenido` ("Qué se dice") y `bloque-visual` ("Nota visual"); y
  `escribir-cta` ("Llamada a la acción").
- Panel derecho sin resultado: "Cómo funciona". Con resultado: "Duración" con
  `escribir-duracion-total` ("M:SS de M:SS objetivo", suma de `segundos` frente a la duración;
  `data-nivel` = `aviso` y chip "Te pasas" si supera el objetivo en más de un 10 %, si no `ok`) y
  `escribir-copiar` ("Copiar guion"): Markdown con el gancho elegido, los bloques
  (`## <título> (Ns)`, contenido y `> Visual: …` si hay nota) y el CTA; confirma con el toast
  "Guion copiado".

### Revisar

- `revisar-guion` (Field "Tu guion" con contador `n / 20000`; por encima, `aria-invalid`),
  `revisar-formato` y `revisar-enviar` ("Revisar guion" / "Revisando…"), deshabilitado con
  `revisar-motivo` ("Pega el guion que quieres revisar.", "El guion pasa de 20.000 caracteres…" o
  "Espera a que el agente termine.").
- `revisar-resultado`: `revisar-veredicto`, `revisar-gancho` (editable, "Gancho reescrito") y
  `revisar-problemas`: tabla Fragmento / Problema / Propuesta con una fila `problema` por elemento
  (sin problemas, una fila "No se han encontrado problemas.").
- Panel derecho: "Qué se revisa" y las fuentes.

### Diagnosticar

- Sin canal autorizado: estado vacío "El canal no está autorizado" con "Autorizar el canal" (va a
  Onboarding) y `diag-motivo` ("Autoriza tu canal en Ajustes u Onboarding."); no se pinta el
  formulario.
- Formulario: `diag-video` (monoespaciado, "ID o URL del vídeo"; admite un ID de 11 caracteres
  `[A-Za-z0-9_-]` o una URL `watch?v=`, `youtu.be/` o `/shorts/`; con otra cosa, `diag-video-error`
  "No es un ID ni una URL de vídeo de YouTube."), `diag-formato` y `diag-analizar` ("Analizar
  retención" / "Analizando…"; deshabilitado mientras el agente responde, porque analizar otro vídeo
  vacía la conversación del modo), con `diag-nota` ("Cuesta unas 100 unidades de cuota (transcripción
  oficial). Los datos de retención tardan 1–2 días en aparecer tras publicar."). Llama a
  `GET /guiones/retencion` directamente, sin el agente.
- `diag-videos` (panel derecho, si `GET /youtube/channel` trae vídeos): "Tus últimos vídeos", un
  botón `diag-video-<id>` por vídeo que rellena el ID y el formato (Short si `es_short`); el elegido
  lleva `aria-pressed="true"`. Debajo, "Cómo se lee".
- Si la respuesta trae `error`: `diag-error` (`role=alert`) con el texto y nada más.
- `diag-resultado`: `diag-titulo` ("<título> · M:SS"); `diag-intro` ("N % sigue viendo a los 30 s",
  o "a los 3 s" en Short; por debajo del 50 %, `data-nivel="aviso"` y chip "Gancho débil");
  leyenda y `diag-curva` (`svg` de 100 % de ancho y 200 px de alto: curva de `watch`, línea
  discontinua al final de la ventana del gancho, una banda `curva-caida` por caída y `curva-pico`
  por pico); `diag-caidas` (Momento `M:SS–M:SS` / Pérdida `−N pp` / Qué se decía, `quote` o "—";
  filas `caida`; sin caídas, "No hay caídas destacables.") y `diag-picos` (igual con "Ganancia"
  `+N pp`, filas `pico`; oculta sin picos); `diag-sin-transcripcion` si `transcript_error` ("Sin
  transcripción: <motivo>. Los momentos se muestran sin texto.").
- Acciones: `diag-proponer` ("Proponer mejoras": envía al agente los momentos ya calculados, no la
  curva) y `diag-guardar` ("Guardar aprendizaje": el agente resume y propone
  `guardar_en_kb_privada`, con la tarjeta de aprobación en `diag-turnos`), deshabilitado hasta que
  termine un turno de "Proponer mejoras".

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
  cuota de la Data API). Los dos periodos de 28 días terminan 3 días antes de hoy, porque
  Analytics llega con 48-72 h de retraso, y no se solapan. Si Analytics no está disponible, el resto del panel se pinta y las
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

## Vídeo (`/video` y `/video/:id`)

Contrato completo de la Task 14. Cada lane (U1–U5) implementa su parte sin tocar este fichero; el
orden de ficheros y de propietarios está en `PLAN-video-fase1.md`. Todo texto del modelo o del
proyecto se pinta como texto (nunca HTML). La UI no envía rutas: los recursos se identifican por
`bandeja_id` (32 hex del comando nativo) y los proyectos, guiones y perfiles por su id de servidor.
Solo hay `src` de iframe desde `url` del backend, y solo si cumple `http://127.0.0.1:4781[0-3]/p/…`
(`aPreviewUrl`). Estado del editor: `state/editor.ts` (historial ≤ 100 instantáneas, autoguardado
con 800 ms de espera; un 409 recarga lo del servidor y guarda la edición local como borrador).

### Marco

`nav-video` («Vídeo»), entre `nav-guiones` y `nav-canal`. Paleta: «Abrir Vídeo». Las rutas
`/video` (`VideoScreen`) y `/video/:id` (`EditorVideoScreen`) están dentro del marco común.
Hasta que U2 las rellene, ambas pantallas están vacías.

### Lista (`/video`)

`video-lista`; por proyecto `video-proyecto-<id>` (título, perfil, duración, fecha),
`video-proyecto-estado-<id>` (`data-estado` = `borrador|renderizando|listo|error`) y
`video-proyecto-borrar-<id>` (con confirmación). Estados: `video-vacio`, `video-sin-motor`
(503 del sidecar) y `video-error`.

### Guiones en modo Vídeo (T15)

`escribir-formato` gana la opción Vídeo. `escribir-video-nota` (coste en cuota de YouTube),
`escribir-video-sin-motor`, `guion-video` (resultado), `guion-video-titulo`, `guion-video-gancho`,
`guion-video-escenas`, `guion-video-escena` (`li`), `guion-video-frase`, `guion-video-tipo`,
`guion-video-subir`, `guion-video-bajar`, `guion-video-recurso`, `guion-video-avisos`,
`guion-video-errores` (`role=alert`), `guion-video-guardar`, `guion-video-crear`,
`guiones-guardados`, `guion-guardado-<id>`, `guion-guardado-borrar-<id>` (abre un diálogo de confirmación «Borrar»/«Cancelar»; si el borrado falla
se muestra un `role=alert`).

### Editor (`/video/:id`)

Layout B: cabecera de 48 px; cuerpo `minmax(0, 1fr) 320px` (preview a la izquierda, panel a la
derecha); timeline a todo el ancho, 240 px, por debajo. Cabe a 900×600.
`editor`, `editor-titulo`, `editor-volver`, `editor-guardado` («Guardado», «Guardando…», «Error al
guardar»), `editor-conflicto`, `editor-deshacer`, `editor-rehacer`, `editor-render`, `editor-error`.
Zonas del layout B (contenedores de las ranuras, medidos por `video-editor.spec.ts`):
`editor-zona-preview`, `editor-zona-panel` (320 px de ancho) y `editor-zona-timeline` (240 px de alto).

- **Preview:** `preview-marco` (iframe 1080×1920 escalado con `transform`), `preview-play`,
  `preview-tiempo`, `preview-cargando`, `preview-error`, `preview-aviso-fondo`.
- **Panel:** `panel-pestanas`, `panel-escena`, `panel-recursos`, `panel-perfil`.
  - Escena: `escena-vacia`, `escena-tipo`, `escena-campo-<campo>`, `escena-frase-<fraseId>`,
    `escena-capa-recurso` (elegir la foto o el clip crea la capa), `escena-capa-sin-recursos`,
    `escena-capa-modo`, `escena-capa-encuadre`, `escena-capa-quitar`.
  - Recursos: `recursos-aviso`, `recursos-anadir-foto`, `recursos-anadir-clip`, `recursos-lista`,
    `recurso-<id>`, `recurso-aviso-<id>`, `recurso-borrar-<id>`, `recursos-pendientes`,
    `recurso-pendiente-<escenaId>`, `recursos-error`.
  - Perfil: `perfil-selector`, `perfil-duplicar`, `perfil-color-<campo>`, `perfil-fuente`,
    `perfil-voz`, `perfil-voz-escuchar`, `perfil-error`.
    `perfil-voz-escuchar` está deshabilitado hasta que T11 fije la muestra de voz (no se llama ni se gasta).
- **Timeline:** `timeline`, `timeline-regla`, `timeline-cabezal`, `pista-escenas`,
  `pista-recursos`, `pista-voz`, `pista-musica`, `pista-subtitulos`, `clip-escena-<id>`,
  `clip-recurso-<escenaId>`, `clip-voz-<fraseId>`, `clip-subtitulo-<i>`, `voz-generar`,
  `voz-coste`, `voz-regenerar-<fraseId>`, `voz-quitar-silencios-<fraseId>`, `voz-sin-clave`,
  `voz-confirmar`, `voz-confirmar-coste`, `voz-confirmar-ok`, `musica-elegir`, `musica-inicio`,
  `musica-volumen`, `musica-ducking`, `subtitulo-texto`.
  Añadidos por T19: `voz-onda` (forma de onda en SVG), `voz-confirmar-cancelar`, `subtitulo-dividir`,
  `subtitulo-unir` y `subtitulo-error` (`role=alert`). Añadidos por el contrato de la voz
  (`docs/video-fase1/contrato-voz.md`): `voz-confirmar-refacturado` (cifra de frases ya cobradas que se
  cobrarían otra vez) y `voz-confirmar-reintentar` (casilla expresa; sin ella no se envía
  `reintentar_facturadas: true` y el botón de confirmar queda deshabilitado). Teclado: en `timeline-regla` (`role=slider`)
  flechas ±0,1 s, Mayús ±1 s, Inicio y Fin; en `clip-escena-<id>` Alt+flecha reordena; en
  `clip-voz-<fraseId>` Mayús+flecha ajusta el final del recorte a una palabra; en
  `clip-recurso-<escenaId>` Alt+flecha mueve la entrada y Mayús+flecha la salida.
- **Render** (Task 20): `editor-render` abre `render-dialogo` (el elemento `role="dialog"`; se monta solo abierto: cada apertura
  vuelve a mirar la voz). Envía `POST /video/proyectos/{id}/render { modo }` con el modo efectivo de
  Ajustes (solo el id y el modo, nunca rutas); el progreso sale del job `video_render` del proyecto
  (`args.id`), sigue vivo si se cierra el diálogo y se retoma al reabrirlo.
  - `render-bloqueo` (`role="status"`, `data-motivo` = `voz` | `guardado`): hay frases sin voz
    (`/voz/coste` con `pendientes`, o 409 `sin_voz`) o el proyecto está sin guardar o en conflicto.
    Mientras exista, `render-lanzar` está deshabilitado.
  - `render-lanzar` («Renderizar», «Renderizar de nuevo» o «Reintentar»): no existe mientras hay un
    render activo.
  - `render-progreso`: barra «Renderizando el vídeo» (indeterminada en cola).
  - `render-resultado`: «Vídeo listo · 12,5 s», con `render-avisos` (lista: codificador y modo,
    `reserva` si el motor tuvo que recurrir a otra vía, y los avisos) y `render-exportar` («Exportar
    MP4» = `invoke("exportar_mp4", { id })`; cancelar el diálogo no es un error; fuera de Tauri
    explica que solo existe en la aplicación).
  - `render-error` (`role="alert"`): fallo del job, del POST o de la exportación; texto sin rutas.

La verificación E2E de cada grupo la escribe el lane que lo implementa, en el mismo commit
(U1 `video-guion.spec.ts`; U2 `video-editor.spec.ts` y `video-preview.spec.ts`; U5
`motor-video.spec.ts` y `video-render.spec.ts`). En la Task 14 solo existe `nav-video`, cubierto
por `marco.spec.ts`. Utilidades compartidas: `e2e/video-comun.ts` (guion y proyecto de ejemplo,
atajos sobre la API real) y `e2e/elevenlabs-mock.ts` (ElevenLabs falso, `VIDEO_PRUEBAS_TTS_URL`).

Seguridad de los E2E: `global-setup` lanza el sidecar sin heredar ninguna variable `*_API_KEY` ni
`*_TOKEN` (las sustituye por valores falsos) y aborta si el mock de ElevenLabs no responde. Mientras
T5 no haga que el motor lea `VIDEO_PRUEBAS_TTS_URL`, ningún E2E de voz debe poder llegar a
`api.elevenlabs.io`; no se desactiva esa defensa.

## Regresión visual

`e2e/visual.spec.ts` captura `chat`, `publicar`, `guiones` (modo Escribir, vacío), `canal`, `kb`, `ajustes`, `ajustes-video` (Ajustes desplazado a «Motor de vídeo»), `video` (lista de proyectos con los cuatro estados), `video-editor` (editor de un proyecto de cocina con la
preview simulada: composición fija de 10 s, sin motor ni voz), `onboarding` y el catálogo
(`/#/catalogo`) en claro y oscuro, a 1200×800 y 900×600 (el catálogo muestra los dos temas, así que
solo se captura una vez por tamaño). Los datos que varían (ajustes, canal, estado de la KB) se
simulan y el reloj se fija (`ajustes-video` muestra el navegador sin descargar; `video` simula `GET /video/proyectos`; `video-editor` usa un
proyecto real del sidecar y simula solo `POST …/preview` y la página del iframe); las referencias están en `e2e/__capturas__/`.

