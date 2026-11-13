# T19 · Pendientes (2026-11-07)

Revisión de seguridad: NO apta en la primera versión. Había 1 High: la UI confirmaba solo una cifra de
caracteres y se podía facturar otro contenido con el mismo total. También había 4 Medium.

Corrección `4ce7618`: contrato de voz fijado en `contrato-voz.md`. El coste y el `plan` salen del
servidor, se confirma el plan, el refacturado necesita una casilla explícita y los errores van por
`codigo`. Re-revisión: cerrada con cambios menores.

Condiciones que T11 tiene que cumplir:
- no fabricar nunca `planConfirmado` (sin él, 422; test `plan_no_se_fabrica`);
- `reintentar_facturadas` solo con `true` literal;
- todo error con `detail: {mensaje, codigo}`.

Menores abiertos:
- `total` de la regla sin tope (Low #9);
- falta el E2E `regenerar_una_frase` (#10, carril U2, sesión local);
- `sin_configurar` también salta si falta la voz elegida (T11 lo separa en `sin_voz`);
- carrera en quitar silencios: si se edita entre la comprobación y `cargar(remoto)`, la edición queda como
  borrador oculto. Hay que volver a comprobar tras el GET.
