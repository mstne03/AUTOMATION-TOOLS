# Pendientes de T17 (preview aislada)

Revisión de seguridad completa: [seguridad-T17.md](seguridad-T17.md). Los cinco Low (2, 3, 4, 5 y 6)
están cerrados en esta rama.

## Condición de integración (Medium 1)

- **T17 no se integra sin T12: `devCsp` y `csp` deben fijar `frame-src` exactamente a
  `http://127.0.0.1:47810 … 47813` (M-D1, I8).** Hoy `devCsp` tiene `frame-src http://127.0.0.1:*` y `csp`
  no tiene `frame-src` (hereda `default-src 'self'` y bloquea el iframe). El cambio es de T12
  (`app-ui/src-tauri/tauri.conf.json`) y no se hace aquí. Debe llevar un test de fichero que falle si
  aparece `127.0.0.1:*` en `frame-src`.

## Decisión documentada: `targetOrigin "*"`

- El `"*"` de `enviarOrden` está justificado: el iframe lleva `sandbox="allow-scripts"` sin
  `allow-same-origin`, su origen es opaco y ningún `targetOrigin` con forma de URL lo iguala.
- Solo viajan `seek`, `play` y `pause` (`seek` con `id` entero y `t` acotado): ni claves, ni rutas, ni
  texto del proyecto. Se envía solo a `iframe.contentWindow`. Cualquier orden nueva exige revisar esto.

## Info del informe (sin tratar)

- **7.** El test «postMessage solo a la ventana del iframe» (`src/test/preview.test.tsx`) solo comprueba que
  `destino` es una cadena: espiar `window.postMessage` y `window.parent.postMessage` con
  `not.toHaveBeenCalled()` y `expect(destino).toBe("*")`.
- **8.** Si `window.__player` no existe, `CONTROL_JS` (T10) manda `listo {duracion: null}` y
  `error {id: undefined}`, que se descartan sin avisar y la UI se queda en «Preparando la preview…».
  Añadir un tiempo de espera (con `sesion.programar`, ~15 s) que pase a `estado error` con texto fijo.
- **9.** `mensaje_hostil_ignorado` (E2E) comprueba `data-descartados` distinto de `0`, que también cumplen
  mensajes ajenos al iframe (extensiones, DevTools): contar aparte los descartes por validación o medir
  la línea base y exigir `≥ 2`.
