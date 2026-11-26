# Seguridad T12 · CSP de la preview, WebRTC e instancia única

Rama `feat/12-csp-preview`. Invariantes: I8 (preview aislada), M-4 (instancia única). Decisión de Marc sobre
M-D4: **sin plugin**; se usa `CreateMutexW` con `windows-sys`, que ya estaba en el proyecto (solo se añade la
característica `Win32_Security`, sin cambios en `Cargo.lock`).

## Qué cambia

- `csp` y `devCsp`: `frame-src http://127.0.0.1:47810 … 47813`, exacto. `devCsp` pierde `127.0.0.1:*` en
  `frame-src`. `capabilities/default.json` sigue con `core:default`.
- `additionalBrowserArgs` de la ventana: los valores por defecto de Tauri
  (`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`) más
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`.
- Instancia única: mutex `Local\SEOStudio-<identifier>` adquirido en `setup`, **antes** de lanzar el sidecar. Si
  existe, la segunda instancia no lanza sidecar ni genera token, deja el error en `Sidecar.failed` (la UI lo
  recibe sin esperar 60 s), muestra un diálogo y sale.

## Tests

- Python (`app-backend/tests/test_preview.py`): `frame_src_sin_comodin`, `puertos_coinciden_con_frame_src`
  (se quitó el `skip`), `connect_src_y_frame_src_solo_loopback`, `capacidades_sin_cambios`,
  `webrtc_sin_fuga_ip_local` (solo comprueba la configuración, no el comportamiento de WebView2). El lector de CSP rechaza directivas repetidas (Chromium aplica la primera).
- Rust: `segundo_adquirir_falla` (y se puede volver a adquirir al soltar), `nombre_local_y_sin_separadores`.
- Pendiente manual de Marc: WebRTC en WebView2 (Playwright no aplica estos argumentos) y la sonda de
  navegación a un quinto puerto con la app real.

## Revisión (Opus, solo lectura) y correcciones

0 Critical, 0 High. Detalle del auditor: `revision-T12.md` (carpeta de notas de la sesión).

| Gravedad | Hallazgo | Estado |
|---|---|---|
| Medium | `disable_non_proxied_udp` **no cierra** WebRTC en el WebView: sin proxy sigue pudiendo salir por TCP hacia un TURN. Solo evita la fuga de la IP local. | Documentado aquí; no se promete «WebRTC cerrado». Cierre real: riesgo residual a decidir (p. ej. `--disable-features=WebRtc…` o E2E) |
| Medium (previo) | `connect-src http://127.0.0.1:*` alcanza Ollama/LM Studio, sin autenticación. | Riesgo residual; el puerto del sidecar es dinámico. No bloquea |
| Low | Directivas CSP repetidas: el test se quedaba con la última. | Corregido (el test falla con duplicados) |
| Low | La aserción sobre `default-src` solo rechazaba `*`. | Corregido (solo `'self'` y `localhost:1420`) |
| Low | Todo fallo del mutex se mostraba como «ya abierto». | Corregido: ACCESS_DENIED/otros dan mensaje propio |
| Info | `unsafe` sin comentario `SAFETY`. | Añadidos |
| Low | Posible carrera con el updater (el instalador relanza antes de que el proceso viejo suelte el mutex). | Abierto: comprobar en la próxima prueba manual de actualización |
| Info | `arrancar_con_instancia_unica` sin test. | Aceptado: la rama de la segunda instancia necesita UI |

El squatting del nombre solo lo puede provocar un proceso del mismo usuario y falla cerrado: impacto bajo.
