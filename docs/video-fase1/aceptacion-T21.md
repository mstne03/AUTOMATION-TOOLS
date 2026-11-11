# Aceptación de la fase 1 de vídeo (T21 · SEO-107) — estado a 2026-11-12, en curso

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
| `aceptacion.test.ts` (CA1, CA5, CA7, CA8), ejecución del subagente | 11/11 OK en 611 s |
| `video-preview.spec.ts` + `visual.spec.ts` (Playwright) | 51 OK |
| `rendimiento_180s` (90 escenas, 179 s) | OK: montar 5,9 s / 120 s; `check` 145 s / 600 s; seek máx. 426 ms / 2 s |
| `fidelidad-preview` CA4 `fotogramas_fijos_ssim` | **FALLA**: SSIM 0,978 frente a 0,99 (ver abajo) |

**Pendiente de ejecutar** (interrumpido a petición de Marc): `render:aceptacion` completo de una
vez, `pnpm e2e` completo, `render-real` (`VIDEO_E2E_REAL=1`, filas 4, 7, 14 y 20 de la tabla
negativa) y `rendimiento_180s` sin carga. Después: commit final, push y CI.

## Decisiones que necesita Marc

1. **CA4 inalcanzable a 0,99 contra el MP4.** La preview y el MP4 son visualmente idénticos (±1 nivel
   en degradados oscuros, PSNR 48,8 dB). Pasar la propia preview por `h264_mf` ya da 0,983. Opciones:
   umbral 0,98 contra un render sin pérdida, PSNR ≥ 40 dB, o subir el bitrate de `h264_mf`
   (`render.ts:50`, cambio de motor). El test sigue estricto a 0,99.
2. **Bug del motor (abrir issue en Plane):** si la escena 1 es `cartel` o `cifra`, `hyperframes check`
   falla con `content_overlap` contra el gancho, y el render acaba en error. Causa probable:
   `composicion.ts:543-549` solo acorta el gancho desde el bloque 2 (`slice(1)`). Los fixtures empiezan
   por `mapa` para esquivarlo.
3. **R2: 0 Critical, 0 High, 2 Medium (verificados en el código), 2 Low, 3 Info.**
   - R2-1: la bandeja de importación está en dos rutas: Rust usa `<estado>\video\bandeja`
     (`lib.rs:480`) y el motor usa `<estado>\video\video\bandeja` (`recursos.ts:48` con `VIDEO_ROOT`).
     En la app instalada no funcionaría ninguna importación; los E2E no lo ven porque simulan Rust.
   - R2-2: el aviso `puertos_preview_ajenos` llega sin `mensaje` (`video_rest.py:861`) y la UI pinta
     `a.mensaje` (`Preview.tsx:257`), así que se ve «undefined». Era la mitigación de R0-7.
4. **Layout del editor a 900×600** (capturas nuevas): el timeline no llega al borde derecho, la fila
   «Música» queda fuera de vista y las píldoras «Pendiente» se recortan.

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
siga vivo. Las filas que dependen de `render-real` están pendientes de ejecutar (ver arriba).

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
3. R2-1 y R2-2 arreglados y probados con Rust real (no solo con E2E simulados).
4. Bug `content_overlap` de la primera escena arreglado, o el piloto avisado de que no empiece por `cartel`/`cifra`.
5. Decisión sobre CA4 y la suite completa en verde: `render:aceptacion`, `render-real` y `pnpm e2e`.
6. Decisión escrita sobre WebRTC en la preview y sonda de red con la app real.
7. Build instalado a mano por Marc; sin release a `main`.
