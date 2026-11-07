# Seguridad T13 · Comandos de importar y exportar

Rama `feat/13-importar-exportar` (desde la cabeza de T12). Invariante I6. Sin dependencias nuevas: solo la
característica `Win32_Storage_FileSystem` de `windows-sys` (sin cambios en `Cargo.lock`).

## Qué cambia

- `importar_recurso(clase) -> Result<Option<String>, String>`: clase de lista cerrada (`foto` 50 MB, `clip`
  500 MB, `musica` 100 MB) con su filtro de extensiones; copia a `<estado>/video/bandeja/<32 hex>.bin` y
  devuelve los 32 hex (128 bits de CSPRNG). `None` si se cancela.
- `exportar_mp4(id) -> Result<bool, String>`: **`true` = guardado, `false` = diálogo cancelado**, cualquier
  fallo es `Err`. Antes devolvía `Option<()>`, que no distinguía los casos. Valida `^video\d{3}$` (solo
  dígitos ASCII) **antes** de tocar el disco. `exportar.ts` devuelve ahora `boolean`; `RenderDialogo` aún lo
  ignora (aviso «MP4 exportado» pendiente en la UI).
- `dir_estado()`: `APP_BACKEND_DIR` o `%LOCALAPPDATA%\seo-studio`, vacío = ausente, como `config.py`. El test
  `dir_estado_sigue_a_config_py` lee `config.py` por literal y falla si cambia.
- Núcleo común `abrir_regular`: abre **una vez** con `FILE_FLAG_OPEN_REPARSE_POINT | BACKUP_SEMANTICS`; sobre
  el handle exige disco (`GetFileType`), ni `REPARSE_POINT` ni carpeta, `nNumberOfLinks == 1` y tamaño ≤
  límite; copia desde ese handle con `take(limite + 1)`; destino `create_new`, borrado si la copia falla.
  Errores con texto fijo: ninguna ruta llega a la UI ni a los logs.

## Tests (`cargo test`, 14 pasan)

`copia_a_la_bandeja_con_id_de_32_hex`, `rechaza_symlink`, `rechaza_hardlink`, `rechaza_junction`,
`rechaza_grande` (incluye el crecimiento tras la comprobación), `rechaza_dispositivos_y_no_deja_destino_a_medias`,
`id_invalido`, `clase_invalida`, `destino_no_se_pisa`, `exportar_rechaza_enlaces_y_grandes`,
`dir_estado_sigue_a_config_py`.

**Aviso:** `rechaza_symlink` se omite (con aviso por stderr) si la máquina no deja crear symlinks sin
privilegio; en esta máquina de Marc se omitió. La CI de `windows-latest` sí lo ejecuta.

## Revisión (Opus, solo lectura): 0 Critical, 0 High

| Gravedad | Hallazgo | Estado |
|---|---|---|
| Medium M1 | Se rechaza cualquier `REPARSE_POINT`, también ficheros de OneDrive (Files On-Demand) o de deduplicación. | **Abierto, falla cerrado.** Mensaje ahora explícito («descárgalo en local»). Pulirlo (rechazar solo *name surrogates* con `FileAttributeTagInfo`) exige probar en la máquina de Marc con OneDrive |
| Medium M2 | `rechaza_junction` pasaba por un fallo incidental de `open`; el destino parcial y `NUL` sin test. | Corregido: `BACKUP_SEMANTICS` (la comprobación de atributos es la que rechaza), test de destino parcial y de `NUL` |
| Low L1 | `OPEN_REPARSE_POINT` solo cubre el último componente; las junctions intermedias se siguen. | Aceptado: mismo usuario, sin escalada. I6 protege al fichero elegido, no a la ruta entera |
| Low L2 | Si el proceso muere a mitad de una exportación queda un MP4 truncado con el nombre final. | Abierto (escribir a `.parcial` y renombrar sin reemplazo) |
| Low L3 | Los `blocking_*` en comandos `async` bloquean workers de tokio y no hay cerrojo: un WebView comprometido podría encadenar diálogos. | Abierto (patrón previo); admitir un solo diálogo a la vez |
| Low L4 | `FILE_SHARE_WRITE` permitía copiar un fichero a medio escribir. | Corregido: `share_mode` solo lectura y borrado/rename |
| Info | El filtro de extensiones no es control de seguridad (el usuario puede escribir `*.*`, ADS o UNC). | El backend comprueba el tipo por magic bytes (I15) |
| Info | Sin cuota ni limpieza de la bandeja. | Fuera de T13: la consume el backend |

**Sacrificio señalado:** el destino de la exportación no se pisa (`create_new`). Si el usuario elige un
fichero existente y confirma «reemplazar» en el diálogo de Windows, la exportación falla con «el destino ya
existe; elige otro nombre». Es la robustez que fija el plan frente a la comodidad.
