"""Formateo compacto de los resultados de busqueda para el cliente MCP.

Tres problemas que resuelve, todos de ahorro de tokens:

- Los chunks llevan grabada dentro una cabecera `[titulo | plataforma | fecha]`
  que la ingesta les pone para que el chunk se entienda suelto. En la respuesta
  es ruido, porque la cabecera ya va fuera.
- El troceado usa 15% de solape a proposito, asi que dos fragmentos contiguos
  del mismo documento comparten texto de verdad. Si los dos entran en el top-k,
  se ve repetido.
- La cabecera de cada resultado ocupaba tres lineas con autor y plataformas.

Y uno de relevancia: con `max_chars`, el recorte se centra en el trozo del
bloque que mas se parece a la consulta, no en su principio. Antes, un bloque que
empezaba por el principio del documento gastaba el presupuesto en el titulo, las
notas de captura y la introduccion.
"""

import re
from collections.abc import Callable

_CABECERA = re.compile(r"^\[[^\]\n]*\](?:\s*\[[^\]\n]*\])?\s*\n")
_ORIGINAL = re.compile(r"^>\s*Original:\s*(\S+)")
_MAX_SOLAPE = 1200
CORTE = "[…]"

# Recibe textos y devuelve un score de parecido con la consulta por texto.
Puntuador = Callable[[list[str]], list[float]]


def quitar_cabecera(content: str) -> str:
    """Quita la linea `[titulo | plataforma | fecha]` que la ingesta antepone.

    Tambien cubre la variante de transcripcion, que anade `[0:00-1:30]`.
    """
    return _CABECERA.sub("", content, count=1).strip()


def solape(anterior: str, siguiente: str) -> int:
    """Longitud del mayor sufijo de `anterior` que es prefijo de `siguiente`."""
    tope = min(len(anterior), len(siguiente), _MAX_SOLAPE)
    for n in range(tope, 20, -1):
        if anterior.endswith(siguiente[:n]):
            return n
    return 0


def limpiar_inicio(texto: str) -> tuple[str, str | None]:
    """Quita la cabecera del documento: el `# titulo` y el blockquote inicial.

    Solo tiene sentido al principio del documento (chunk 0). En mitad del texto
    un blockquote es contenido y no se toca. Devuelve el texto limpio y la url
    de la linea `> Original: ...`, si la habia.
    """
    lineas = texto.split("\n")
    i = 0

    def saltar_vacias() -> None:
        nonlocal i
        while i < len(lineas) and not lineas[i].strip():
            i += 1

    saltar_vacias()
    if i < len(lineas) and lineas[i].startswith("# "):
        i += 1
        saltar_vacias()

    original = None
    while i < len(lineas) and lineas[i].lstrip().startswith(">"):
        m = _ORIGINAL.match(lineas[i].lstrip())
        if m:
            original = m.group(1)
        i += 1

    return "\n".join(lineas[i:]).strip(), original


def recortar(
    texto: str,
    max_chars: int | None,
    puntuar: Puntuador | None = None,
) -> str:
    """Recorta a `max_chars` alrededor de lo mas relevante, en unidades completas.

    Parte el texto en parrafos (un titulo `#` va pegado al parrafo que le
    sigue), elige el que `puntuar` considera mas parecido a la consulta y
    amplia hacia los lados, anadiendo cada vez el vecino mas parecido que
    quepa. Marca con `[…]` donde se ha quitado texto; la marca cuenta dentro de
    `max_chars`. Sin `puntuar`, o si falla, parte del principio.
    """
    if not max_chars or len(texto) <= max_chars:
        return texto
    return _ventana(_parrafos(texto), "\n\n", max_chars, puntuar)


def _parrafos(texto: str) -> list[str]:
    bloques = [p.strip() for p in re.split(r"\n\s*\n", texto) if p.strip()]
    unidades: list[str] = []
    pendiente = ""
    for b in bloques:
        es_titulo = b.startswith("#") and "\n" not in b
        if pendiente:
            b = f"{pendiente}\n\n{b}"
            pendiente = ""
        if es_titulo:
            pendiente = b
        else:
            unidades.append(b)
    if pendiente:
        unidades.append(pendiente)
    return unidades


def _frases(texto: str) -> list[str]:
    return [f for f in re.split(r"(?<=[.!?:])\s+", texto) if f]


def _ventana(
    unidades: list[str],
    sep: str,
    max_chars: int,
    puntuar: Puntuador | None,
) -> str:
    n = len(unidades)
    scores: list[float] | None = None
    if puntuar and n > 1:
        try:
            scores = list(puntuar(unidades))
        except Exception:  # noqa: BLE001 - sin puntuacion se recorta desde el principio
            scores = None
    if not scores or len(scores) != n:
        scores = [float(n - i) for i in range(n)]   # prefiere lo primero

    def largo(a: int, b: int) -> int:
        cuerpo = sum(len(u) for u in unidades[a : b + 1]) + len(sep) * (b - a)
        marcas = (len(CORTE) + 1) * ((a > 0) + (b < n - 1))
        return cuerpo + marcas

    mejor = max(range(n), key=lambda i: scores[i])
    a = b = mejor

    if largo(a, b) > max_chars:
        # La unidad sola no cabe: se baja a frases, y si es una frase, a palabras.
        frases = _frases(unidades[mejor])
        hueco = max_chars - (len(CORTE) + 1) * ((a > 0) + (b < n - 1))
        if len(frases) > 1:
            interior = _ventana(frases, " ", hueco, puntuar)
        else:
            interior = _cortar_en_palabra(unidades[mejor], hueco)
        return _marcar(interior, a > 0, b < n - 1)

    while True:
        vecinos = [i for i in (a - 1, b + 1) if 0 <= i < n]
        vecinos.sort(key=lambda i: scores[i], reverse=True)
        for v in vecinos:
            na, nb = min(a, v), max(b, v)
            if largo(na, nb) <= max_chars:
                a, b = na, nb
                break
        else:
            break

    return _marcar(sep.join(unidades[a : b + 1]), a > 0, b < n - 1)


def _cortar_en_palabra(texto: str, limite: int) -> str:
    """Ultimo recurso para una frase suelta mas larga que el limite."""
    limite -= len(CORTE) + 1
    if limite <= 0:
        return CORTE
    cortado = texto[:limite]
    espacio = cortado.rfind(" ")
    if espacio > limite * 0.5:
        cortado = cortado[:espacio]
    return cortado.rstrip() + " " + CORTE


def _marcar(texto: str, antes: bool, despues: bool) -> str:
    if antes and not texto.startswith(CORTE):
        texto = f"{CORTE} {texto}"
    if despues and not texto.endswith(CORTE):
        texto = f"{texto} {CORTE}"
    return texto


def agrupar(results: list[dict]) -> list[dict]:
    """Funde los fragmentos contiguos del mismo documento en un solo bloque.

    Mantiene el orden por score: cada grupo hereda el mejor score de sus
    fragmentos, y los grupos se devuelven en ese orden.
    """
    por_documento: dict[int, list[dict]] = {}
    for r in results:
        por_documento.setdefault(r.get("document_id"), []).append(r)

    grupos: list[dict] = []
    for fragmentos in por_documento.values():
        fragmentos.sort(key=lambda r: r.get("chunk_index") or 0)

        actual: list[dict] = []
        for r in fragmentos:
            contiguo = (
                actual
                and r.get("chunk_index") is not None
                and actual[-1].get("chunk_index") is not None
                and r["chunk_index"] - actual[-1]["chunk_index"] == 1
            )
            if actual and not contiguo:
                grupos.append(_fundir(actual))
                actual = []
            actual.append(r)
        if actual:
            grupos.append(_fundir(actual))

    grupos.sort(key=lambda g: g["score"], reverse=True)
    return grupos


def _fundir(fragmentos: list[dict]) -> dict:
    """Une una tirada de fragmentos contiguos, recortando el solape real."""
    base = max(fragmentos, key=lambda r: r["score"])
    texto = quitar_cabecera(fragmentos[0]["content"])

    for siguiente in fragmentos[1:]:
        limpio = quitar_cabecera(siguiente["content"])
        n = solape(texto, limpio)
        if n:
            # El solape es exacto: pegando el resto tal cual se conserva el
            # separador original, incluido un salto de parrafo.
            texto = texto + limpio[n:]
        elif limpio:
            texto = texto.rstrip() + "\n\n" + limpio

    original = None
    if fragmentos[0].get("chunk_index") == 0:
        texto, original = limpiar_inicio(texto)

    fundido = dict(base)
    fundido["content"] = texto.strip()
    fundido["url_original"] = base.get("url_original") or original
    fundido["fragmentos"] = len(fragmentos)
    fundido["chunk_index"] = fragmentos[0].get("chunk_index")
    return fundido


def formatear(
    results: list[dict],
    query: str,
    max_chars: int | None = None,
    puntuar: Puntuador | None = None,
) -> str:
    """Respuesta compacta: una linea de cabecera por bloque y el texto debajo.

    La cabecera usa la url original cuando el documento es un archivo local
    capturado a mano, y no cuenta para `max_chars`.
    """
    grupos = agrupar(results)

    total = len(grupos)
    etiqueta = "bloque" if total == 1 else "bloques"
    lines = [f'{total} {etiqueta} para "{query}":', ""]

    for i, g in enumerate(grupos, 1):
        fecha = g["published_at"] or "sin fecha"
        url = g.get("url_original") or g["url"]
        lines.append(f"[{i}] {g['title'] or 'Sin titulo'} | {fecha} | {url}")
        lines.append(recortar(g["content"], max_chars, puntuar))
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"
