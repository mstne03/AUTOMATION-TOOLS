# Revisión de seguridad · T1 (esquema del guion y del proyecto)

Alcance: `git diff 40b457b e739ddd` (rama `feat/t1-esquema-guion`): `video-mcp-server/src/esquema.ts`,
`test/esquema.test.ts`, exportación de `hallazgosDeRed` (`src/composicion.ts`) y `Object.hasOwn` (`src/mapas.ts`).
Referencias: PLAN-video-fase1.md «Task 1» (Seguridad, R0-4, R0-8), SPEC-video.md I1, I2 (c), I6; HANDOFF §2 (A1).

Ejecución: `npx vitest run test/esquema.test.ts` → 27/27 PASS. Los hallazgos se han comprobado con un test
temporal (ya borrado), sin tocar el repositorio.

## Veredicto

**Aprobable con cambios. Sin Critical ni High.** El núcleo cumple: no hay campos de ruta ni de URL, todos los
objetos son estrictos, todas las cadenas y todos los arrays tienen tope, los campos de estilo son enums cerrados,
`__proto__`/`constructor` se rechazan, los números son finitos y están acotados, y `ErrorEsquema` solo lleva
ruta y código. Hay tres Medium que conviene cerrar antes de integrar, sobre todo M1, porque invalida la
garantía de la R0-8 y el test que debería cubrirla es tautológico.

| # | Sev. | Resumen |
|---|---|---|
| M1 | Medium | `textoSeguro` mira el texto crudo y `urlsDeRed` mira el texto escapado: divergen (`<//h`, `>//h`, `&constructor;//h`). El test de equivalencia es tautológico |
| M2 | Medium | Pasan caracteres invisibles o de formato (Cf): LRM/RLM/ALM (Bidi_Control), etiquetas U+E0000–E007F, ZW*, BOM, U+2028/2029, U+FFF9–FFFB y no-caracteres |
| M3 | Medium | `ESQUEMA_RE` es cuadrática; `recomendaciones` acepta entrada sin validar y sin tope (200 KB → 30 s de CPU en el motor) |
| L1 | Low | `.max()` va antes de NFC: el texto normalizado puede triplicar el tope |
| L2 | Low | La R0-8 pide rechazar `[a-z][a-z0-9+.-]*://`, pero pasan `ftp://`, `javascript://`, `data:` y `x:////h` |
| L3 | Low | `musica.pistaId` es un id abierto: ni `RECURSO_ID_RE` ni referencia a un recurso `musica`, y admite `CON`/`NUL` |
| L4 | Low | Índices (`destellos`, `golpe.frase`, `correcciones.indice`, `cortes`) sin cruce con el número real de escenas o frases |
| L5 | Low | `capa.recursoId` puede apuntar a un recurso de clase `musica` |
| L6 | Low | Debilidades de tests: el centinela de `error_sin_valor` lleva `-` y el recorrido de `sin_cadena_sin_tope` es parcial |
| L7 | Low | `nombreOriginal` admite una ruta absoluta completa (privacidad; no la usa nadie como ruta) |

---

## M1 · Divergencia entre `textoSeguro` y `urlsDeRed` (Medium)

**Dónde:** `src/esquema.ts:54` (`hallazgosDeRed(s, "texto.html")` sobre el texto crudo);
`src/composicion.ts:711,730` (`ENTIDADES[nombre] ?? m` sobre un objeto literal);
`test/esquema.test.ts:463-485`.

**Escenario.** La R0-8 pide que el esquema rechace lo que `urlsDeRed` marcaría en la composición. Pero la
composición nunca contiene el texto crudo: contiene `escaparHtml(texto)`, y `hallazgosDeRed` decodifica las
entidades una sola vez. Resultado comprobado (A1 controla el texto):

| Texto | `validarGuionVideo` | `hallazgosDeRed(escaparHtml(t), "x.html")` |
|---|---|---|
| `<//host` | acepta | 1 hallazgo (`&lt;` no está en `ENTIDADES`, y `;` precede a `//`) |
| `>//host` | acepta | 1 hallazgo (`&gt;//host`) |
| `&constructor;//host`, `&valueOf;//h` | acepta | 1 hallazgo |

En el último caso hay además un fallo de prototipo de la misma familia que `ALIAS_PAISES`.
`ENTIDADES["constructor"]` devuelve `Object`, y `textoSeguro` ve `function Object() { [native code] }//host`,
con `}` delante de `//`, así que no marca nada. Una vez escapado, `&amp;constructor;` se decodifica a
`&constructor;` y queda `;//host`, que sí se marca.

Impacto: el modelo entrega un guion que pasa el esquema y la UI, pero el render se rechaza más tarde con un
error de URL. El fallo se ve (I11) y no sale nada a la red; la CSP y el proxy nulo siguen siendo la barrera. Lo
que se pierde es la garantía de la R0-8 («si el esquema lo acepta, `urlsDeRed` no lo marca»): A1 puede dejar
proyectos que no se renderizan.

**Test que no prueba lo que dice.** «rechaza cada muestra que urlsDeRed marcaría» escribe `m` **sin escapar** en
`t.html`, y `textoSeguro` aplica la misma función a la misma cadena. La comparación es tautológica: solo podría
fallar por NFC y nunca detectará esta divergencia.

**Corrección.**
1. En `textoSeguro`, comprobar las formas en que el texto llega a la composición:
   `hallazgosDeRed(s, "t.html") || hallazgosDeRed(escaparHtml(s), "t.html") || hallazgosDeRed(jsonParaScript(s), "t.json")`.
   Otra opción: rechazar directamente `[<>&"'`(=,;]` seguido de `[\\/]{2}`.
2. En `composicion.ts:730`: `Object.hasOwn(ENTIDADES, nombre) ? ENTIDADES[nombre] : m`, o un `Map`.
3. Rehacer el test para que escriba `escaparHtml(m)` (y una variante con `jsonParaScript`) en `t.html`/`t.json`.
   Añadir a las muestras `<//h`, `>//h`, `&constructor;//h` y `&toString;//h`.

## M2 · Caracteres invisibles y de formato que pasan (Medium)

**Dónde:** `src/esquema.ts:40` (`PROHIBIDOS_RE`).

**Escenario.** El filtro cubre C0, DEL, C1 y U+202A–202E y U+2066–2069, que es exactamente la lista del plan.
Comprobado que pasan:
- U+200E/U+200F/U+061C (LRM, RLM, ALM). Son `Bidi_Control` en Unicode, así que la lista «sin bidi» de la
  spec está incompleta.
- U+E0000–E007F (etiquetas). Sirven para el «ASCII smuggling»: A1 puede guardar en `titulo`, `gancho` o frases
  un texto que el usuario no ve al revisar y aprobar el guion. Ese texto acaba en el proyecto, en ElevenLabs
  (se factura por caracteres) y en cualquier contexto que más adelante vuelva al modelo, como la edición con
  IA o la fase 3. Eso anula la revisión humana como control.
- U+200B–200D, U+2060–2064, U+FEFF, U+FFF9–FFFB, U+00AD, no-caracteres (U+FFFE/FFFF) y uso privado.
- U+2028/U+2029: contradicen el «todo texto en una línea» de `descripcionEsquema`. `jsonParaScript` los
  escapa, pero en HTML y en los subtítulos pueden partir la línea.

**Corrección.** Rechazar por categoría con el flag `u`:
`/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\u{FFFE}\u{FFFF}]/u` (más los no-caracteres `\uFDD0-\uFDEF` si se
quiere). Admitir U+200D (ZWJ) solo si se aceptan emojis compuestos, y nunca seguido de otro Cf. Tests en
`texto_control` para U+200F, U+061C, U+E0041, U+200B, U+FEFF y U+2028.

## M3 · Coste cuadrático en `ESQUEMA_RE`, alcanzable por `recomendaciones` (Medium)

**Dónde:** `src/composicion.ts:714` (rama `[^\s"'<>)\\/]*\.`); `src/esquema.ts:315-347`.

**Escenario.** Con `"http:".repeat(n/5)`, cada `\bhttp:` recorre la cadena hasta el final buscando un `.`.
Medido: 4 KB → 12 ms, 40 KB → 1,2 s, 200 KB → 31 s. Dentro del esquema está acotado (cadenas ≤ 400, peor guion
de 90×6 frases → 98 ms). Pero `recomendaciones` «nunca lanza» y acepta cualquier objeto: el test le pasa
basura sin validar a propósito. Con una frase de 200 KB, `recomendaciones` tardó 30 s. Si un carril posterior
(T2 o el backend) llama a `recomendaciones` antes de validar, o sobre un guion que no pasó el esquema para dar
pistas, A1 bloquea el motor Node, que tiene un solo hilo y atiende también el estado del render. Que
`hallazgosDeRed` sea ahora una exportación pública amplía los posibles llamantes.

**Corrección.**
1. Hacer lineal la regex: `[^\s"'<>)\\/.]{0,253}\.` (excluir `.` de la clase y acotar a la longitud máxima
   de un nombre de host).
2. En `recomendaciones`, no procesar cadenas de más de `LIMITES.fraseChars`, y como máximo
   `LIMITES.escenas × LIMITES.frasesPorEscena` frases. Mejor aún, tiparla y documentarla solo para entrada ya
   validada.
3. Test de tiempo: 200 KB de `http:` en menos de 50 ms.

---

## L1 · El tope se mide antes de NFC (Low)

`src/esquema.ts:48-50`: `.max(max)` va antes de `.transform(normalize)`. NFC puede alargar el texto:
U+FB2C da 3 puntos de código y U+1D160 pasa de 2 a 6 unidades. Comprobado: un `cartel.texto` de 40 se queda
en 120 tras validar. El total de narración sí se mide tras NFC. Impacto: maquetación y desbordes; los topes
por campo dejan de ser los anunciados. **Corrección:** `z.string().max(max * 4).transform(nfc).pipe(z.string().min(min).max(max))`,
o comprobar la longitud dentro del `superRefine`.

## L2 · Esquemas genéricos que no se rechazan (Low)

`src/esquema.ts:54`. La R0-8 enumera `[a-z][a-z0-9+.-]*://`, pero `hallazgosDeRed` solo ve `http(s)`, `ws(s)`,
`file:` y `//host` tras ciertos delimitadores. Pasan `ftp://host`, `javascript://x`, `data:text/html,x`,
`blob:` y `x:////host`. Hoy todo es texto escapado en nodos de texto, y la CSP y el proxy bloquean la red, así
que no hay fuga. Es una divergencia con el plan. **Corrección:** añadir a `textoSeguro` un rechazo propio de
`/\b[a-z][a-z0-9+.-]*:\/\//i` y de `\b(?:javascript|data|blob|vbscript):`; o, si se decide no hacerlo,
corregir el texto de la R0-8.

## L3 · `musica.pistaId` es un id abierto (Low)

`src/esquema.ts:225`. La SPEC §203 dice que la música la aporta el usuario, o sea, un recurso de clase
`musica`. Sin embargo, `pistaId` usa `ID_LOCAL_RE`, no `RECURSO_ID_RE`, y no se cruza con `recursos`. Es el
único campo que referencia un fichero sin seguir la convención de ids del backend (I6), y admite nombres
reservados de Windows (`CON`, `NUL`, `COM1`) si algún día se usa como nombre de fichero. **Corrección:**
`RECURSO_ID_RE` y comprobar que exista en `recursos` con `clase: "musica"`; si es un catálogo, un enum
cerrado.

## L4 · Índices sin cruzar (Low)

`src/esquema.ts:141,143,232,233`. `destellos` (≤ 89), `golpe.frase` (≤ 539), `correcciones[].indice` y
`cortes` (≤ 5000) se aceptan aunque superen el número real de escenas, frases o palabras (comprobado: un
guion de una escena con `destellos:[89]` y `golpe.frase:500` pasa). La composición actual hace
`ventanas[n - 1].corte`, que lanza un TypeError: el error se ve, pero no se entiende. **Corrección:** en el
`superRefine` raíz, comprobar `< escenas.length` y `< frases.length`, y rechazar duplicados en `destellos`.

## L5 · `capa` hacia un recurso `musica` (Low)

`src/esquema.ts:253`. Se comprueba que `recursoId` existe, pero no su clase. **Corrección:** exigir
`clase ∈ {foto, clip}` en la referencia.

## L6 · Tests que prueban menos de lo que dicen (Low)

- `error_sin_valor` (`test/esquema.test.ts:335`): el centinela `SECRETO-9f3a` contiene `-`, y el filtro de
  `ruta` (`esquema.ts:286`) lo convertiría en `?` aunque zod lo metiera en la ruta. Una clave alfanumérica
  del atacante (`SECRETO9f3a`) pasaría ese filtro. Hoy zod no mete claves desconocidas en `path` (van en
  `keys`, que no se copia), así que no hay fuga, pero el test no lo demuestra. **Corrección:** añadir un
  centinela solo alfanumérico como clave desconocida en varios niveles.
- `sin_cadena_sin_tope` (`test/esquema.test.ts:85-114`): el recorrido no baja por `record`, `tuple`,
  `intersection`, `lazy`, `catch` ni `readonly`. Hoy no existen, pero un `z.record` futuro pasaría sin tope.
  **Corrección:** fallar ante cualquier `def.type` no contemplado.
- El test de equivalencia de URL es tautológico (ver M1).

## L7 · `nombreOriginal` puede llevar una ruta absoluta (Low)

`src/esquema.ts:184`. Admite `C:\Users\marc\…\x.jpg` hasta 120 caracteres. Es texto de UI y nadie lo usa como
ruta, pero si la UI o el comando Rust enviasen la ruta completa, quedaría en `proyecto.json`. **Corrección:**
rechazar `/`, `\` y `:` en este campo (o guardar solo el `basename`).

---

## Comprobado sin hallazgos

- **Rutas y URLs encubiertas:** ningún campo `ruta|url|path|src|archivo`. Los ids de proyecto, recurso y perfil
  van por regex anclada. `ID_LOCAL_RE` no admite `.`, `/`, `\` ni `:`.
- **Prototype pollution:** `__proto__` (propio, vía `JSON.parse`) da `unrecognized_keys` en todos los
  niveles. `Object.hasOwn` en `ALIAS_PAISES` y `EXT_POR_CLASE`. `resolverZona` con `constructor`,
  `__proto__`, `toString`, `hasOwnProperty` y `valueOf` → sin zona.
- **Números:** zod 4.6.7 rechaza `Infinity`/`NaN`. Se rechazan `"12"` y `null`, `cifra12` va en ±1e12,
  `ancho` y `alto` son enteros ≤ 8192, y los tiempos son ≥ 0 y crecientes en `recorte` y `capa`.
- **Enums:** `fondo`, `look`, `subtitulos`, `estilo`, `clase`, `ext`, `region`, `modo`, `encuadre` y
  `recurso.tipo` son listas cerradas. `ext` depende de `clase`. `tunel` queda fuera de la unión.
- **Arrays y cadenas enormes:** 200 000 escenas → `too_big` en 1 ms; un título de 5 MB → 5 ms (zod corta antes
  del `transform`).
- **`ErrorEsquema`:** mensaje constante, como mucho 50 problemas `{ruta, codigo}`, sin `cause`, y el código
  custom sale de `params`, fijado por el esquema.
- **ReDoS en las regex propias de `esquema.ts`:** todas son lineales y ancladas.
- **`recomendaciones`:** los mensajes solo llevan números y texto fijo, nunca texto del atacante.
