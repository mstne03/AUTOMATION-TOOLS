# T8 · Pendientes (2026-11-07)

Revisión de seguridad: integrable, sin Critical, High ni Medium (5 Low y 5 Info, en `seguridad-T8.md`).

- L1: un perfil roto a mano (incluido `defecto.json`) no se puede reparar desde la app, porque `guardar`
  exige que el fichero actual sea válido. Propuesta: permitir sobrescribirlo con un perfil válido si el
  actual no valida, avisando.
- L2: `proyectoCrear` no comprueba que el perfil exista. Quien consuma el tema (T3, T6 y T10) debe fallar
  de forma visible y nunca caer a `defecto` (I11).
- Decisión del implementador: `defecto` existe sin fichero y usa la voz predefinida
  `21m00Tcm4TlvDq8ikWAM`. Marc puede cambiarla.
