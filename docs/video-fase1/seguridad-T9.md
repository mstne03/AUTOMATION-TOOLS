# R1 de seguridad · T9 (frontera REST del guion)

Rama `feat/t9-rest-guion`, diff `bf37c9f..HEAD` (commits 91077bf, 7305a5f). Revisión de solo lectura.
Referencias: PLAN-video-fase1.md Task 9 con las enmiendas de la R0, Global Constraints,
SPEC-video.md I1, I6, I8, I10 e I11, y HANDOFF-video-fase1.md §2.

## Veredicto

**Aprobado con cambios.** No hay hallazgos Critical ni High. Hay 3 Medium que conviene cerrar antes
de integrar T9 (el M3 condiciona la puerta R1 de T1, T3 y T9) y 8 Low.

Ejecución: `uv run --no-sync pytest -q tests/ --deselect tests/test_kb_privada.py` da 312 passed,
19 skipped. `test_kb_privada.py` falla por el entorno: intenta descargar el modelo de fastembed y
recibe un 403. Además se ejecutaron sondas en un test temporal, `tests/test_tmp_sondas_sec.py`, que
ya está borrado; el árbol de trabajo queda limpio.

## Lo que se ha comprobado y está bien

- **Bearer.** Las rutas de `/video/` heredan `protegido` del router (`video_rest.py:237`).
  `test_todas_las_rutas_exigen_bearer` recorre las rutas, entra en los routers incluidos y no admite
  excepciones. Con el sondeo, un id con forma mala y sin token da 401, no 404: el token se resuelve
  antes que el patrón.
- **Patrones.** Todos los parámetros de ruta llevan `pattern`, también las rutas antiguas, con
  `ID_URL` (`main.py:242,249,269,295`), y el test `todas_las_rutas_con_patron` lo vigila. Resultados
  del sondeo:
  - `%0A` al final da 404, porque el regex de Rust de pydantic no acepta `$` antes de un salto de línea.
  - `%2F`, `%5C`, `..`, `CON`, `%00` y las mayúsculas dan 404.
  - `vide%6F001` se decodifica a un id legítimo, lo cual es correcto.
  - Unicode: ver L1.
- **Id del cuerpo.** Si `proyecto.id` no coincide con el id de la ruta, la respuesta es 422
  (`video_rest.py:283`). Si falta, ver L7.
- **Tope de 1 MiB.** `LimiteCuerpo` es ASGI puro, cuenta el flujo real y rechaza antes de empezar la
  respuesta, también con chunked y sin `Content-Length`. El orden de los middleware es
  CSP > CORS > tope, así que el 413 lleva CORS y CSP. h11 rechaza un `Content-Length` duplicado o
  incoherente.
- **JSON acotado.** La profundidad se mide de forma iterativa, con un máximo de 16. La recursión del
  parser (50 000 niveles) y los enteros de más de 4300 dígitos acaban en `ValueError` o
  `RecursionError` y dan 422. `extra="forbid"` va en el sobre y `revision` es entero estricto.
  `_ruta_segura` impide que el nombre de una clave del atacante vuelva en la respuesta.
- **Esquema.** El backend no lo valida y lo reenvía al motor tal cual (`guion: dict`,
  `proyecto: dict`). No abre ningún hueco propio: el backend no interpreta el contenido, solo `id` y
  `revision`.
- **Errores sin tipar del motor** (excepción de Node, `MCPError`). Salen como un 502 genérico, sin
  texto, y se quedan en el log (`video_rest.py:197-198`).
- **Timeouts.** `MotorTimeout` da 503, la sesión se reinicia y la siguiente llamada funciona
  (`test_motor_cuelga_503_y_sigue`).
- **Registro de tools.** Ninguna tool `video_*` entra en `registry.build()`
  (`test_registry_sin_tools_video`), y `/jobs` rechaza `video_render`.
- **CSP.** `sandbox; default-src 'none'` va en toda respuesta que pase por los middleware de usuario,
  incluidos 401, 404, 413 y la petición previa de CORS. El middleware solo toca
  `http.response.start`, así que el SSE no cambia: los tests del chat pasan con la app completa.
- **Documentos de FastAPI.** `/docs`, `/redoc` y `/openapi.json` están desactivados y dan 404.
- **Borrado.** Solo se borran hijas directas de `VIDEO_ROOT`. Una raíz que sea un enlace da 409 y no
  se toca. Dentro, los enlaces se quitan sin seguirlos (`_borrar`).
- **`test_navegador.py`.** Solo amplía la lista blanca de I10 a `video_rest.py` con
  `{es_enlace, _borrar}`. No relaja nada más: el resto de módulos sigue sin poder usar el navegador.

## Hallazgos

### M1 · Medium · `_sin_rutas` no tapa las rutas con espacios, que son las habituales en Windows

- **Dónde.** `app-backend/app_backend/video_rest.py:38` (regex `_RUTA_EN_TEXTO`) y `:181-188`, donde
  `_http` aplica el filtro a los 503 y a los errores tipados. El texto llega desde
  `app_backend/video.py:283-284` (`No se pudo arrancar…: {_describir(e)}`) y desde `:426`
  (`NavegadorError` con rutas).
- **Escenario.** La regex corta en el primer espacio. Resultados del sondeo:
  - `'C:\Users\Marc Serra\AppData\Local\x\node.exe'` queda como `'… Serra\AppData\Local\x\node.exe'`.
  - `C:\Program Files\SEO Studio\video-engine\node\node.exe` queda como
    `… Files\SEO Studio\video-engine\node\node.exe`.
  - `%LOCALAPPDATA%\SEO Studio\video` no se toca.

  La app instalada vive justo en rutas así. Cuando el motor no arranca, o falla la verificación del
  navegador, la UI recibe la ruta con el nombre de usuario. Es el control «Filtrar secretos o rutas
  en errores» de la tabla de amenazas, con la prueba `error_sin_ruta`. Esa prueba solo usa rutas sin
  espacios (`motor_falso.py`, `g-ffff…` y `g-eeee…`), así que no detecta el fallo. El impacto es
  revelar información; no hay secretos, porque la clave ya se tapa con `_ocultar`.
- **Corrección.** No reenviar texto libre del motor:
  - Para `MotorNoDisponible` y `MotorTimeout`, un mensaje fijo por clase (ya existen
    `MENSAJE_DETENIDO` y `MENSAJE_NO_INSTALADO`), con el detalle solo en el log.
  - Para los errores tipados, un mensaje fijo por `codigo`.

  Si se mantiene el filtro, que tape desde la letra de unidad o `\\` hasta la comilla o el final de la
  línea, incluidos los espacios, y que tape también `%VAR%`. Hay que añadir al test los casos
  `C:\Users\Nombre Apellido\…` y `C:\Program Files\…`.

### M2 · Medium · El borrado de proyecto no se coordina con el motor, y un fichero en uso da un 409 falso de «es un enlace»

- **Dónde.** `video_rest.py:212-229` y `:289-297`, y `navegador._borrar` (`navegador.py:136-162`).
- **Escenario.**
  1. Un `DELETE` corre en un hilo mientras el motor atiende un `PUT` del mismo proyecto (el autoguardado
     de la UI) u otra operación. No hay cerrojo por proyecto entre el backend y el motor: los
     `Cerrojos` de T11 solo cubren el render y la voz. Lo que puede pasar:
     - El motor crea un temporal o renombra `proyecto.json` mientras `_borrar` recorre la carpeta.
       `os.rmdir` falla con «directorio no vacío» y el proyecto queda **medio borrado**: puede faltar
       `proyecto.json` y seguir `voz/`, o al revés.
     - El `guardar` del motor recrea la carpeta después del borrado y deja un huérfano.
  2. En Windows, borrar un fichero abierto (la preview de T10, un render, el antivirus) lanza
     `PermissionError` (WinError 32), que es subclase de `OSError`. La ruta lo captura primero en
     `:293` y responde «La carpeta del proyecto es un enlace y no se borra.», con el proyecto ya
     borrado a medias.
  3. El motor no se entera del borrado: su caché o su `siguienteId` pueden reutilizar el id (es el
     riesgo de R0-5 que T10 ata con `creado`).

  No permite borrar fuera del proyecto. Afecta a la integridad de los datos del usuario
  (Review Focus 4) y deja un 409 engañoso.
- **Corrección.**
  - Distinguir el enlace con una excepción propia, por ejemplo `ProyectoEsEnlace`, en lugar de
    reutilizar `PermissionError`.
  - Serializar por proyecto: un `asyncio.Lock` por id en el backend, que tomen PUT y DELETE. O mejor,
    borrar por medio del motor, que conoce sus escrituras en vuelo.
  - Hacer el borrado atómico: primero `os.rename(carpeta, raiz/".borrando-<id>-<rand>")`, que falla
    entero si algo está abierto y deja el proyecto intacto, y después `_borrar` sobre la carpeta
    renombrada.
  - Tests: `borrar_con_fichero_abierto_409_intacto` (solo Windows) y `borrar_durante_put`.

### M3 · Medium · Las negativas de esquema prueban el simulador, no el motor; faltan negativas del plan

- **Dónde.**
  - `app-backend/tests/motor_falso.py:74-101,175-182`: el simulador valida por su cuenta
    (`CLAVES_GUION`, más de 90 escenas, claves del proyecto).
  - `tests/test_video_rest.py:89-108,212-215`: `ruta_en_cuerpo_422` (el caso de dentro),
    `proto_rechazado`, `limites_en_rest` y `proyecto_manipulado_422`.
  - `tests/test_video_rest.py:340-357`: el único test contra el motor real está marcado como `skip`.
- **Escenario.** Por diseño, el backend no valida el esquema. Por tanto, esas cuatro pruebas verifican
  la lógica de `motor_falso.py` y no la frontera. Pasarían igual aunque el `.strict()` real de T1
  dejara pasar `__proto__`, rutas o 91 escenas. El simulador también inventa el formato del error
  tipado (`{codigo, problemas}` en el último bloque), que T4 aún no ha fijado. `_error_tipado` acepta
  ese bloque en cualquier posición, así que un cambio de formato en T4 convertiría todos los 422 en
  502 sin que falle ningún test.

  Faltan además pruebas de la tabla de amenazas de la Task 9:
  - `xss_en_cada_campo`, con POST real y `_composicion/**` sin `<script>`.
  - `modelo_no_llega_a_rutas`, con un turno que invente una tool `video_*`.
  - `url_en_texto_inerte`.

  El plan pide que «los de esquema [vayan] contra el motor real por `APP_BACKEND_VIDEO_CMD`».
- **Corrección.**
  - Hacer de `test_esquema_y_xss_contra_motor_real` una puerta de integración: que falle y no se
    salte cuando `VIDEO_ENGINE_R1=1` o en la rama de integración, y que cubra `proto`, `ruta`,
    `limites`, `proyecto_manipulado`, `xss_en_cada_campo` y la forma del error tipado.
  - Añadir `modelo_no_llega_a_rutas`.
  - Marcar en `motor_falso.py` qué negativas son del simulador, para que no cuenten como cobertura de
    la frontera.
  - No integrar T9 hasta que el test real se ejecute con T4.

### L1 · Low · `\d` acepta dígitos Unicode en el id de proyecto

- **Dónde.** `video_rest.py:28` (`PROYECTO = r"^video\d{3}$"`), que se usa en la ruta (regex de Rust
  de pydantic, con `\d` Unicode) y en `borrar_proyecto` (`re.fullmatch` de Python, también Unicode).
- **Escenario.** `GET /video/proyectos/video١٢٣` pasa el patrón y llega al motor. En el sondeo,
  `DELETE /video/proyectos/video١٢٣` borró la carpeta `video١٢٣` (200). No hay recorrido de rutas
  posible, porque los dígitos no son separadores. Aun así, el patrón no es el que dice el plan
  (`\d` ASCII de JS en el motor) y los dos lados dejan de coincidir.
- **Corrección.** Usar `^video[0-9]{3}$`. Revisar también `RECURSO` y `BANDEJA`, aunque ya usan
  `[0-9a-f]`. Añadir `video١٢٣` al parametrizado de `test_id_recorrido_404`.

### L2 · Low · Los `problemas` del motor se reenvían sin filtrar

- **Dónde.** `video.py:114-129` (`_error_tipado` solo trunca a 80 y 60 caracteres) y
  `video_rest.py:192`.
- **Escenario.** Si T1 o T4 ponen en `ruta` el nombre de una clave desconocida, o en `codigo` un
  mensaje de zod, ese texto del atacante (vía la salida del modelo) vuelve a la UI. El sondeo devolvió
  tal cual `{"ruta": "escenas.0.<img src=x>", "codigo": "C:\\Users\\marc"}`. La UI no lo pinta como
  HTML, así que no hay XSS. Pero el backend aplica `_ruta_segura` a sus propios errores y no a los del
  motor.
- **Corrección.** Aplicar `_ruta_segura` a cada segmento de `ruta`, y limitar `codigo` a
  `[a-z_]{1,40}` o a una lista cerrada de códigos de zod y del motor.

### L3 · Low · Los 500 no llevan CSP

- **Dónde.** `main.py:162-173`. `ServerErrorMiddleware` envuelve los middleware de usuario.
- **Escenario.** Una excepción no capturada, por ejemplo un fallo inesperado en `motor_de`, devuelve
  `500 Internal Server Error` sin `Content-Security-Policy`. El sondeo lo confirma: `csp=None`. Es
  texto plano y no hay `debug`, así que el riesgo es mínimo, pero el plan dice «toda respuesta».
- **Corrección.** Envolver la app ya construida, sacando `CabeceraCSP` fuera de
  `ServerErrorMiddleware` (por ejemplo, devolver `CabeceraCSP(app)` desde `main()`). La otra opción es
  un `exception_handler(Exception)` que responda JSON. Test: `respuesta_500_con_csp`.

### L4 · Low · `NaN` e `Infinity` se aceptan y llegan al motor como `null`

- **Dónde.** `video_rest.py:166` (`json.loads` sin `parse_constant`).
- **Escenario.** `{"guion": {"version": NaN, "titulo": Infinity}}` se acepta (201 con el simulador). El
  cliente MCP serializa los no finitos como `null`, así que el motor valida un documento distinto del
  que envió la UI. No abre hueco, porque el motor valida lo que recibe, pero cambia datos en silencio.
- **Corrección.** Usar `json.loads(crudo, parse_constant=_rechazar_no_finito)` y responder 422 con
  `codigo: "json"`.

### L5 · Low · Borrado: ni los ancestros de `VIDEO_ROOT` ni la recursión se protegen frente a TOCTOU

- **Dónde.** `video_rest.py:220-228` y `navegador.py:151-156`.
- **Escenario.**
  - Si `<estado>/video` o `<estado>/video/proyectos` es una junction, el borrado sigue al destino:
    solo carpetas llamadas `videoNNN`, pero fuera del estado.
  - Entre el `lstat` de una subcarpeta y su `scandir`, un proceso del usuario podría cambiarla por una
    junction.

  Hace falta escribir en `%LOCALAPPDATA%` con la misma cuenta, lo que queda fuera del alcance de A1.
  Aun así, `navegador.comprobar_ancestros` ya existe para esto mismo.
- **Corrección.** Llamar a un equivalente de `comprobar_ancestros` para `VIDEO_ROOT` antes de borrar.
  El renombrado atómico de M2 reduce además la ventana.

### L6 · Low · Un timeout reinicia la sesión compartida del motor principal

- **Dónde.** `video.py:229-232`.
- **Escenario.** Una llamada de guion que se cuelga 120 s descarta el proceso. Las llamadas en vuelo
  del mismo canal, incluida la voz de T5 cuando exista, fallan con 503. Es el comportamiento pedido
  (`motor_cuelga_503_y_sigue`), pero conviene saberlo para T5 y T11.
- **Corrección.** Ninguna en T9. En T5, considerar un timeout corto para las tools de guion, o un canal
  aparte.

### L7 · Low · El PUT acepta un `proyecto` sin `id` y no compara `revision`

- **Dónde.** `video_rest.py:283`.
- **Escenario.** La enmienda de la R0 pide que el id del cuerpo coincida con el de la ruta. Si el
  cuerpo no trae `id`, se acepta (200 con el simulador) y se confía en que el motor lo rellene o lo
  exija. Tampoco se compara `proyecto.revision` con `revision`.
- **Corrección.** Exigir `cuerpo.proyecto.get("id") == id`, y si existe `proyecto.revision`, que
  coincida con `revision`. Test: `id_ausente_422`.

### L8 · Low · `video_rest.py` depende de un ayudante privado

- **Dónde.** `video_rest.py:22` y `tests/test_navegador.py:1366`.
- **Escenario.** `_borrar` es privado y destructivo. Cambiarlo dentro de `navegador.py` afecta en
  silencio al borrado de proyectos.
- **Corrección.** Exponerlo como `borrar_sin_seguir_enlaces` con su propio test, y ajustar la lista
  blanca de I10.

## Notas

- **Límite de cuerpo.** El tope de 1 MiB solo cubre `/video/`. El resto de rutas, como el chat o los
  ajustes, sigue sin tope; es así desde antes de T9.
- **Prueba de SSE.** El plan pide comprobar «SSE del chat sin cambios» junto a `respuesta_con_csp`.
  Lo cubren de forma indirecta los tests del chat con la app completa. Una prueba explícita del
  `text/event-stream` con la CSP lo dejaría fijado.
- **Precondiciones del revisor (M-1, `check ok:false`, Untrusted, W3.x, `VIDEO_ENGINE` apagada).** No
  se pueden verificar desde este diff. Sin `VIDEO_ENGINE`, el release responde a las rutas nuevas con
  un 503 legible (`MENSAJE_NO_INSTALADO`), no con un 500.
