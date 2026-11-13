# Registro de errores

Incidentes que no deben repetirse. Para cada uno: qué pasó, por qué, qué se corrigió y qué regla deja.
Las reglas vigentes se copian en `CLAUDE.md`, que es lo que lee cualquier sesión al arrancar.

## 2026-11-10/11 · Una copia de `node_modules` llenó el disco C:

**Qué pasó.** La sesión de Claude Code de la tarea T7 (worktree `7-recursos-a42486`) lanzó en segundo
plano este comando:

```powershell
robocopy "...\worktrees\6-montaje-05e9f4\video-mcp-server\node_modules" `
         "...\worktrees\7-recursos-a42486\video-mcp-server\node_modules" /E /NFL /NDL /NJH /NJS /NP /MT:16
```

Lo hizo para tener dependencias sin descargar nada, porque el encargo prohibía las descargas. El
proceso siguió vivo cuando la sesión terminó su turno y escribió más de 200 GB en unas horas. C: pasó de
144 GB libres a 0. Ninguna sesión pudo ejecutar comandos, y liberar espacio no servía porque se volvía
a llenar. Marc tuvo que localizar el proceso y matarlo a mano.

**Por qué.**
- `test/hyperframes-comun.ts › copiaSinParche()` creaba `node_modules/.sin-parche-XXXX/` y, dentro,
  una junction `node_modules` → `dirname(realpath(hyperframes))`. En el worktree `6-montaje`,
  `hyperframes` era un directorio real y no una junction de pnpm. Por eso ese `dirname` era el propio
  `node_modules`, y la junction apuntaba a la carpeta que la contenía: un ciclo.
- Cuando el test no llegaba a su `afterAll` (ejecuciones interrumpidas o fallidas), las carpetas
  `.sin-parche-*` se quedaban dentro de `node_modules`.
- `robocopy /E` sin `/XJ` sigue las junctions como si fueran carpetas. Por eso entró en
  `.sin-parche-X\node_modules\.sin-parche-X\node_modules\...` sin fin.
- `/NFL /NDL /NJH /NJS /NP` ocultaban toda la salida y `/MT:16` multiplicaba la velocidad. Nada avisó.

**Qué se corrigió.**
- `copiaSinParche()` crea la copia en `os.tmpdir()` y no dentro de `node_modules`. Rechaza una
  junction que apunte a una carpeta que la contenga. Si la preparación falla, lo limpia todo en el
  momento. `borrar()` quita primero la junction (solo el enlace) y después la copia.
- `CLAUDE.md` tiene la sección «Ficheros y disco» con las seis reglas.

**Restos conocidos (no se han borrado sin permiso de Marc).**
- `worktrees\6-montaje-05e9f4\video-mcp-server\node_modules\.sin-parche-HbWTKv` y `.sin-parche-zEksqs`,
  con la junction cíclica dentro.

**Lección para quien escribe encargos.** Un encargo que prohíbe las descargas tiene que decir cómo
instalar las dependencias: `pnpm install --offline` o, si no se puede, parar y preguntar. Si no lo
dice, el agente improvisa.
