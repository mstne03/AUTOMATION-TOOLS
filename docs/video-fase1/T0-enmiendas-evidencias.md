# T0 Step 2: enmiendas aplicadas en SPEC-video.md (rama feat/t0-enmiendas-spec, sin commit)

Solo se editó SPEC-video.md (el diff de HANDOFF-nube-trivy-fase1.md ya estaba en el árbol antes; no es mío).
Nota añadida: «Enmiendas de la fase 1 (2026-11-07)» al final de §Seguridad, antes de «Revisión de seguridad».

## M-1 · I2 (b)
Cambio: bypass limitado al puerto exacto del servidor local; descritos `<-loopback>;host:puerto`, sin URL no se exceptúa nada, WebRTC/QUIC.
Evidencia: video-mcp-server/patches/hyperframes+0.8.206.patch (seoStudioBypass, SEO_STUDIO_SIN_BYPASS/CON_BYPASS, SEO_STUDIO_ARGS_WIN32, SEO_STUDIO_FUERA); test/parche-hyperframes.test.ts:505-515.
Dudas: (1) la spec decía `--proxy-server=127.0.0.1:1` y host-resolver `MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1`; el código usa `0.0.0.0:1` y `MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1` (hyperframes-comun.ts:19 PROXY_NULO). Alineé la spec con el código. (2) Solo win32: lo dije con «En Windows».

## M-2 · I4
Cambio: excepción única `chrome-headless-shell-win64/debug.log`, solo ruta exacta y fichero normal (sin enlaces ni hardlink), no listable en manifiesto, backend y motor igual; no es código.
Evidencia: video-mcp-server/src/proceso.ts:173-178 y 264-270; app-backend/app_backend/config.py:115 y navegador.py:253-255; commits 541e68f, a24d8ae; test/sandbox-render.test.ts:662-667.
Duda: «ningún flag de log lo evita en el CfT fijado» viene del comentario del test (CfT 156), no lo he reproducido.

## M-3 · I7
Cambio: barrido por ruta de imagen tras timeout o CLI con error; objetivos (ffmpeg/ffprobe exactos, carpeta del CfT con manifiesto; en desarrollo solo exe y ffmpeg solo con FFMPEG_DIR); no toca hijos en vuelo ni otro motor vivo; falla cerrado y reinicia el motor.
Evidencia: proceso.ts:468-480 (lanzar), 555-640 (carpetasDelBundle/filtrarProcesos), 710-780 (seleccionarBarrido), 806-846 (barrerProcesos); commits 73c2e79, 8e37d1a, d7cb11d.
Duda: el texto original decía «timeout o cancelación»; en el código el barrido se dispara por `r.timeout` o `cli && code !== 0`, no por cancelación explícita (no encontré un camino de cancelación que barra). Escribí lo que hace el código. El «Job Object» de I7 ya estaba en la spec y no se tocó (video.py:13-14, commit 6d39017).

## W1.3 · Riesgos residuales (sandbox del renderer y cierre de red)
Cambio: nuevo punto de riesgos residuales: UDP efímero en 0.0.0.0 con WebRTC (mDNS 5353 cerrado); accesos de red en Node solo cortados por el entorno de I13; admisión de Low <2 s en el test de I3. Añadida frase: el parche rechaza `--single-process`/`--in-process-gpu`.
Evidencia: test/sandbox-render.test.ts:718-735; patch (WebRtcHideLocalIpsWithMdns, SEO_STUDIO_UN_PROCESO); test/parche-hyperframes.test.ts:107-140 (soloEntorno); commit 23d9d80.
Dudas: el texto original de W1.3 no está en el repo; reconstruido de tests y parche. Puede faltar algún residual que Marc tuviera en el ledger.

## W1.6 · Riesgos residuales (integridad del motor y del render)
Cambio: verificarDist es integridad, no autenticidad; el resto de dist/ y node_modules sin hash; ventana de comprobación; límites del barrido (procesos sin ruta, falla cerrado).
Evidencia: proceso.ts:289-296 (comentario de verificarDist), 715-720.
Dudas: igual que W1.3 (ledger ausente). No añadí residuales de codificador/rendimiento (el HANDOFF habla de ello en W1.6) porque no los verifiqué en render.ts.

## W1.5 · I4 (ffmpeg sustituible y frontera de construcción)
Cambio: hoy BtbN LGPL con SHA-256 fijado; el build propio lo sustituye en W3.2 sin cambiar I4; frontera: fuentes con hash y firma, descarga y compilación en contenedores separados (compilación sin red), solo protocolos file y pipe; SHA-256 en prepare-video-engine.sh es el control final.
Evidencia: app-ui/scripts/prepare-video-engine.sh:29-32 y 131-141; video-mcp-server/ffmpeg-build/LEEME.md («Puerta W3.2», «Cadena de suministro», «Contenedores»); componentes.conf.
Dudas: el rechazo de `.dll` extra en la carpeta del ffmpeg NO está implementado (no hay código en proceso.ts); lo marqué en la spec como requisito de W3.2 aún pendiente. Las tareas 10 de ffmpeg-build siguen con marcadores PENDIENTE-TAREA-10, así que «sustituirá» es futuro.

## M-D1 · I8 y diagrama de fronteras
Cambio: texto literal de I8 («`frame-src` lista exactamente los puertos de preview fijados en `tauri.conf.json`; nunca `127.0.0.1:*`»), puerto propio 47810–47813, sin preview si los cuatro están ocupados, la composición no alcanza la API ni sin bearer; dos líneas nuevas en el diagrama.
Evidencia: PLAN-video-fase1.md:44.
Duda: app-ui/src-tauri/tauri.conf.json:24 aún tiene `frame-src http://127.0.0.1:*` en devCsp (no era mi alcance; lo cambiará la implementación). Sigo sin reflejar «32 bytes de clave de capacidad» distinto: se mantiene tal cual.

## M-D2 · D8, Fases
Cambio: fase 1 = lista simple `perfiles/<id>.json`, Duplicar, `perfilId` en el proyecto, sin importar ni IA; fase 3 sin «varios perfiles»; actualizadas las líneas de Fases.
Duda: `<id>` llega de la UI y forma una ruta; la spec no dice que se valide por regex (I6 solo nombra ids de proyecto y recurso). Recomiendo ampliar I6/I1 a «perfil»; no lo hice por ser fuera de las enmiendas aprobadas. Ojo: criterio de aceptación 1 y D8 ya coinciden.

## M-D7 · D9
Cambio: fondo = fotograma fijo del clip con CSS `filter: blur()`; no se mueve.
Evidencia: ffmpeg-build/componentes.conf:46 (lista de filtros sin boxblur/gblur). `capa-clip.html` aún no existe en plantilla/piezas.

## M-D8 · D4
Cambio: `tunel` fuera del esquema del modelo en fase 1; pieza probada por el adaptador; entra en fase 2.
Evidencia: video-mcp-server/plantilla/piezas/escena-tunel.html existe; `tunel` no estaba en D4.

## Otras observaciones
- La cabecera de §Seguridad dice «Las invariantes I1–I12» pero la tabla llega a I15; no lo toqué.
