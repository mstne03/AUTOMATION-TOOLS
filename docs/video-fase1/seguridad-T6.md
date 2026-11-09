# Seguridad de T6

Revisión Opus (`cyber-security-auditor`, solo lectura) sobre el diff de T6: informe completo en `auditoria-T6-opus.md`.
Resultado: Critical 0, High 0, Medium 1, Low 7, Info 3. Nada bloquea.

| Id | Estado |
|---|---|
| M-1 barrido al arrancar/por tool podía reiniciar el motor (`exit 70`) | **Corregido**: sin `reiniciar` al arrancar ni a petición (se registra y se deja); tras un timeout se mantiene. Test en `barrido-arranque.test.ts`. |
| L-3 `prepararProyecto` del render fuera de `enSerie` | **Corregido** (`encolarRender` lo serializa). |
| L-1 filtro de flags de Chrome salta con `-`, `/` o mayúsculas | Pendiente (endurecer `SEO_STUDIO_CDP`, con su manifiesto). |
| L-2 `_composicion/` y `_render/` sin comprobación de junction | Pendiente. |
| L-4 `video_barrer_procesos` visible en modo independiente | Pendiente. |
| L-5 dev: `HYPERFRAMES_BROWSER_PATH` al Chrome del usuario | Pendiente (solo desarrollo). |
| L-6 rutas absolutas en `reserva`/`avisos` (I6) | Pendiente; el backend ya sanea avisos. |
| L-7 `_render/<job>` huérfanas si el motor muere | Pendiente: barrer `_render/` al arrancar. |

Sin re-revisión Opus: la corrección de M-1 (un parámetro) y L-3 (una envoltura) es mínima y la cubren los tests.
I2, I11 e I13 sin hallazgos propios; I7 solo M-1 y L-5.
