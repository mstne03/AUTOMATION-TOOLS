# T9 · Pendientes (2026-11-07)

- Revisión de seguridad: aprobada con cambios. M1–M3 y L1–L5 y L7 cerrados (`c9be125`). Re-revisión:
  cerrada con cambios menores.
- R1 conjunta T1 → T9: aprobada con cambios. N1 (sustituto UTF-16 suelto) y N2 (`/video/capacidades`
  con rutas) cerrados en `8887fe5`.
- **La R1 no se cierra hasta T3** (sesión local), con estas condiciones:
  - test de XSS con un POST real que compruebe que ningún fichero de `_composicion/**` contiene el texto
    del atacante sin escapar y que `urlsDeRed` queda vacío;
  - negativas de T3 en verde;
  - T3 consume solo el `Proyecto` ya validado;
  - repetir la R1 sobre T1 + T3 + T9.
- Menores abiertos:
  - no hay barrido de `.borrando-*`;
  - el cerrojo de borrado solo existe en el backend (el motor no lo conoce);
  - `1e400` todavía da `inf` en un camino (L4);
  - no se comprueba si `VIDEO_ROOT` es una junction (L5);
  - L6 y L8 (ver `seguridad-T9.md`).
- La CI no compila `video-mcp-server/dist` en el job `python`, así que los `test_real_*` se saltan
  allí. Se ejecutan en local con `VIDEO_ENGINE_R1=1` tras `npx tsc -p tsconfig.json` (61 pasan).
  Conviene añadir el build del motor a ese job.
