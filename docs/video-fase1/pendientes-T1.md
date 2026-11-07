# T1 · Pendientes tras la re-revisión de seguridad (2026-11-07)

Re-revisión acotada de `53bb7b2`: **cerrada con cambios menores**. Sin Critical ni High.
Antes de integrar T1, y en cualquier caso antes de la R1 conjunta T1+T3+T9:

1. **Regresión en `urlsDeRed` (Low, primero):** el tope `{0,253}` de `ESQUEMA_RE` (corrección M3)
   deja de detectar `http:` + más de 253 caracteres de usuario o contraseña + `@evil.com`, que antes
   se detectaba. Propuesta del auditor, lineal y que además cubre `http:intranet`:
   `\b(?:https?|wss?):(?=[^\s"'<>)])`. Añadir test con ese caso y volver a medir el de 200 KB.
2. **M1, campos unidos:** la composición escapa `prefijo + "0" + sufijo` (`composicion.ts`, `INICIAL`).
   Con `prefijo: "http:a"` y `sufijo: ".es"`, el esquema acepta el guion y la composición marca la URL.
   Validar la unión en el `superRefine` de `cifra` y `barras`.
3. **M2, invisibles que quedan:**
   - Selectores de variación U+E0100–E01EF y U+FE00–FE0E (categoría Mn, sirven para «emoji smuggling»).
   - U+034F, U+115F, U+3164 y U+2800.
   - Rechazarlos y admitir U+FE0F solo tras una base emoji.
4. **L2, falsos positivos:** «Big data:2024», «FTP:21» y «Blob:3». Exigir una letra o `/` después de `:`.
5. **M3:** el test de tiempo de 500 ms puede fallar a veces en una máquina lenta; subir el margen.
6. **Para Plane:** L3–L6 de `seguridad-T1.md`; L7 deja un falso positivo menor («a..b.jpg»).
