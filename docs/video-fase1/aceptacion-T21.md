# Aceptación de la fase 1 de vídeo (T21 · SEO-107) — estado a 2026-11-12

Rama `feat/21-aceptacion` desde `feat/video-fase1-integrada` (4366e03). Sin PR ni fusión a `ds/v1`.
Detalle por pieza: `T21-aceptacion-motor.md`, `T21-fidelidad-rendimiento.md`, `T21-smoke-capturas.md`
y la R2 en `R2-fase1.md`.

## ffmpeg de los renders

Todos los renders usan el ffmpeg LGPL del bundle actual: BtbN `n7.1.5-12 win64-lgpl-7.1`, con el
SHA-256 fijado en `app-ui/scripts/prepare-video-engine.sh` (comprobado) y sin `libx264` ni `--enable-gpl`.
Se pasa por `FFMPEG_DIR`; el del PATH (full build de WinGet) no se usa. El build LGPL propio
(W1.5) aún no sustituye a BtbN: la puerta W3.2 sigue abierta.

## Resultados (máquina de Marc)

| Suite | Resultado |
|---|---|
| `cargo test` (con los marcadores de empaquetado de CI) | 14 OK |
| `pytest -q` | 627 OK, 9 omitidos |
| `pnpm test` | 389 OK |
| `npm test` | 1150 OK, 69 omitidos |
| `render:mock` | 1 OK |
| `render:sandbox` | 21 OK |
| `render:aceptacion` (`aceptacion` + `fidelidad-preview`) | CA1, CA5, CA7, CA8: 11 OK (cocina empieza ya por `cartel`); CA4: 10 OK con la métrica nueva (ver «Arreglos tras la R2») |
| `render-real` (`VIDEO_E2E_REAL=1`) | 7 OK, 2 omitidos, 1 falla: el oráculo de sockets (ver abajo) |
| `rendimiento_180s` sin carga (90 escenas, 179 s) | OK: montar 5,2 s / 120 s; `check` 144 s / 600 s; seek máx. 266 ms / 2 s |
| `pnpm e2e` completo | 212 OK (6,7 min) |
| CI (`workflow_dispatch` sobre la rama) | Verde tras trocear la clave centinela de CA7 (`gitleaks` la tomaba por `generic-api-key`) |

**Correcciones de test hechas en la rama:**

- `render-real.test.ts` generaba `voz.mp3` con AAC/ADTS dentro. Desde SEO-110 el motor fuerza el
  demuxer por extensión (`argsEntrada`) y lo rechaza, que es lo correcto. Ahora el fixture es un MP3 de
  verdad (`libmp3lame`, como `e2e-mock`).
- La clave centinela falsa de CA7 se monta troceada, y `.gitleaks.toml` acota el commit 920c1a6 (regla,
  fichero y commit).

**Oráculo de sockets de `render-real` (fila 14 de la tabla negativa):** en esta máquina,
`Get-NetTCPConnection` y `netstat` solo ven 6 sockets en escucha en todo el sistema, y no ven ni un
servidor de prueba en 127.0.0.1, ni dentro ni fuera del sandbox de la sesión. El test lo detecta y
falla cerrado, como debe («la tabla de escuchas no es fiable en este entorno»). La fila queda cubierta
por `render:sandbox` (21 OK) y por la medida manual M-5.

## Arreglos tras la R2 (2026-11-12, con el sí de Marc)

| Punto | Arreglo | Prueba |
|---|---|---|
| R2-1 · bandeja en dos rutas | `carpetaBandeja` = `dirname(VIDEO_ROOT)/bandeja` = `<estado>ideoandeja`, la que escribe `lib.rs` | `recursos.test.ts` (contrato) y `test_bandeja_del_motor_es_la_de_rust` (backend) |
| R2-2 · aviso «undefined» | La preview traduce el `codigo` con la tabla cerrada de `render/resultado.ts` (`aFrase`); el tipo `AvisoPreview` refleja el contrato real (`{ codigo, puertos? }`) | `preview.test.tsx` con la forma real de `POST …/preview` y texto hostil |
| Escena 1 `cartel`/`cifra` (`content_overlap`) | Si el bloque 1 es una escena, su contenido entra cuando acaba el gancho (deja ≥ 1 s visible; si no cabe, el gancho se acorta a ≥ 0,9 s) | `composicion.test.ts` (cartel y cifra) y render real del fixture `cocina`, que empieza por `cartel` |
| CA4 · métrica | Preview frente al render **sin pérdida**: PSNR ≥ 36 dB; preview frente al MP4 de `h264_mf`: SSIM ≥ 0,97 | `fidelidad-preview.test.ts` |

**CA4, medidas (dos ejecuciones idénticas):** MP4 SSIM 0,978 en los 5 instantes; render sin pérdida
PSNR 46,0 / 38,4 / 45,8 / 38,8 / 45,8 dB a 2 / 5 / 8 / 11 / 14 s. Propuse 40 dB con una sola medida
(48,8 dB) y los carteles con el halo radial a pantalla completa dan 38,4–38,8 dB. La diferencia ×10 son
anillos de cuantización del degradado y el antialias del texto, sin bordes dobles: no hay desfase de
fotograma. Umbral calibrado a 36 dB (≈ 2,5 dB de margen sobre el peor caso).

**Hallazgo menor (no arreglado):** el motor devuelve los avisos de la preview como texto (`plan.avisos`),
y `video_rest.py` solo deja pasar objetos con `codigo`, así que esos avisos de texto no llegan a la UI.
Tampoco pueden pintarse tal cual (regla de producto: texto del motor no confiable). Para una fase
posterior: que el motor emita códigos.

**Pendiente de Marc:**

- Layout del editor a 900×600 (capturas nuevas): el timeline no llega al borde derecho, la fila
  «Música» queda fuera de vista y las píldoras «Pendiente» se recortan.
- R2 restante: 2 Low (R2-3 IPC desde el iframe sin prueba; R2-4 WebRTC en la preview) y 3 Info, en `R2-fase1.md`.

## Pruebas negativas mínimas de la spec, sobre la rama integrada

| # | Prueba de la spec | Test(s) principales | Suite | Cobertura |
|---|---|---|---|---|
| 1 | Plantilla hostil (`fetch`, `<img //…>`, `WebSocket`) en render y preview | `csp-integracion.test.ts` «una pieza hostil no llega a la red ni en la preview ni en el render (I2 a)» + controles; `sandbox-render.test.ts` | `npm test` (con `VIDEO_ENGINE_DIR`), `render:sandbox` | Completa (sumideros loopback en vez de 203.0.113.1) |
| 2 | JS en `vendor/` con URL externa | `urls-de-red.test.ts` «mira dentro de vendor…» | `npm test` | Completa |
| 3 | `HYPERFRAMES_BROWSER_PATH` inexistente + `chrome.exe` señuelo | `parche-hyperframes.test.ts` «prueba negativa de la spec…», `proceso-entorno.test.ts` | `npm test` | Completa |
| 4 | Render con `HOME` redirigido | `render-real.test.ts` «…HOME redirigido: no toca las cachés del usuario (I13)» | `render-real` | **Parcial**: no mide conexiones a `registry.npmjs.org` |
| 5 | Espía de la CLI: variables de I13 | `proceso-entorno.test.ts` «toda invocación de la CLI lleva el modo cerrado…» | `npm test` | Completa |
| 6 | Entorno de hijos = lista blanca I5 | `proceso-entorno.test.ts` «entornoHijo solo contiene claves de la lista blanca»; `aceptacion.test.ts`; `test_video.py` | `npm test`, `render:aceptacion`, `pytest` | Completa |
| 7 | `.dll` extra en el CfT | `navegador-manifiesto.test.ts`; `render-real.test.ts` «CfT con una .dll añadida…»; `test_navegador.py` | `npm test`, `render-real`, `pytest` | Completa |
| 8 | Zip con `..\..\x.dll` | `test_navegador.py` `test_zip_con_hash_correcto_y_traversal_rechazado`, `test_extraer_rechaza_traversal_sin_escribir_fuera` | `pytest` | Completa |
| 9 | `.mp4` que es HLS/`concat` | `recursos.test.ts` «mp4_que_es_hls_o_concat…» | `npm test` | Completa (comprueba que ffmpeg no se lanza) |
| 10 | PNG 20000² o clip de 2 h | `recursos.test.ts` «png_20000…», «clip_2h…» | `npm test` | Completa |
| 11 | Color con inyección / fuente fuera de lista | `proyecto.test.ts` «proyecto_en_disco_malo…», `esquema.test.ts`, `perfil.test.ts` | `npm test` | Completa |
| 12 | Alineación hostil (`NaN`, retrocede, 10⁶) | `voz.test.ts` «respuesta hostil: no se guarda nada», `tts.test.ts` | `npm test` | **Parcial**: no comprueba explícitamente que el motor sigue vivo |
| 13 | Junction interna a centinela | `test_video_rest.py` `test_junction_interna_centinela_intacta`; `proyecto.test.ts` | `pytest`, `npm test` | Completa |
| 14 | Sockets de descendientes en 127.0.0.1 | `render-real.test.ts`; `sandbox-render.test.ts` | `render-real`, `render:sandbox` | Completa |
| 15 | `<script>` / `{{…}}` escapados | `composicion.test.ts`, `composicion-n.test.ts` | `npm test` | Completa |
| 16 | Recurso symlink/hardlink/junction | `recursos.test.ts` «enlaces (I6)»; `lib.rs` `rechaza_symlink/hardlink/junction` | `npm test`, `cargo test` | Completa |
| 17 | Zip de CfT con un byte cambiado | `test_navegador.py` `test_zip_con_un_byte_cambiado_no_se_abre` | `pytest` | Completa |
| 18 | Binario de CfT cambiado tras verificar | `navegador-manifiesto.test.ts` «exe con un byte cambiado…»; `test_navegador.py` | `npm test`, `pytest` | Completa |
| 19 | Clave de ElevenLabs ausente | `aceptacion.test.ts` (CA7, sobre render real); `generico.test.ts`; `composicion-sin-secretos.test.ts`; `test_video.py` | `render:aceptacion`, `npm test`, `pytest` | Completa |
| 20 | Timeout sin procesos bajo CfT/ffmpeg | `render-real.test.ts` «render con timeout no deja procesos…»; `proceso-barrido.test.ts` | `render-real`, `npm test` | Completa |
| 21 | Renderer Untrusted | `sandbox-render.test.ts` «renderer Untrusted…» | `render:sandbox` | Completa |

Huecos: la fila 4 no mide conexiones a `registry.npmjs.org` y la fila 12 no comprueba que el motor
siga vivo. Todas las suites de la columna «Suite» se han ejecutado en esta rama; la fila 14 en
`render-real` no es medible en esta máquina (ver arriba).

## Pasos manuales de Marc

- **M2:** WebGPU en el iframe de WebView2 con la RTX 4060 (CA4 con WebGPU).
- **M-5:** medir los sockets en escucha con la app real durante un render.
- **Clips H.264:** importar y renderizar clips reales (`h264_mf` y `h264_nvenc`).
- **CA8 sin GPU:** equipo real sin GPU; comprobar que se elige `h264_mf` y que la reserva se ve.
- **WebRTC:** en WebView2 y en la preview (heredado T12 Medium, R2-4); decidir el riesgo por escrito.
- **OneDrive:** confirmar que el rechazo de `REPARSE_POINT` (T13 M1) no bloquea a usuarios de OneDrive.
- **IPC desde el iframe:** probar a mano que la preview no llega a `sidecar_info` ni a `abrir_url` (R2-3).

## Condiciones para `VIDEO_ENGINE=1` en el piloto local

1. T0 aprobada, W3.x integradas (incluida W3.2: el build LGPL propio sustituye a BtbN con el SHA fijado)
   y W3.5 (borrado del spike).
2. M-4 cerrada, M-5 medida y M2 hecha.
3. R2-1 y R2-2 arreglados (hecho) y la importación probada con la app instalada (Rust real, no E2E simulados).
4. Decisión escrita sobre WebRTC en la preview y sonda de red con la app real.
5. Build instalado a mano por Marc; sin release a `main`.
