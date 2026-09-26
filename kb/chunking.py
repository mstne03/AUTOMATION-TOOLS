"""Troceado de documentos.

Dos estrategias:

- `chunk_text`  : texto con estructura (web, pdf, markdown). Respeta parrafos.
- `chunk_transcript`: transcripciones de YouTube. No tienen parrafos ni
  puntuacion fiable, asi que se trocea por ventanas de tiempo con solape.

Ambas antepone a cada chunk una linea de contexto `[Titulo | plataforma | fecha]`
para que el chunk se entienda suelto, que es como lo vera el buscador.
"""

import re

TARGET_CHARS = 2400       # ~600 tokens
OVERLAP_RATIO = 0.15


def context_header(title: str | None, platforms: list[str], published_at) -> str:
    """Construye la linea `[Titulo | plataforma | fecha]`."""
    parts = [
        (title or "Sin titulo").strip(),
        ", ".join(platforms) if platforms else "general",
        str(published_at) if published_at else "sin fecha",
    ]
    return "[" + " | ".join(parts) + "]"


def chunk_text(text: str, header: str) -> list[str]:
    """Trocea texto respetando parrafos, con ~15% de solape."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if not paragraphs:
        return []

    # Un parrafo mas largo que el objetivo se parte por frases.
    units: list[str] = []
    for p in paragraphs:
        units.extend(_split_long(p, TARGET_CHARS))

    chunks: list[str] = []
    current: list[str] = []
    size = 0

    for unit in units:
        if current and size + len(unit) + 2 > TARGET_CHARS:
            body = "\n\n".join(current)
            chunks.append(body)
            tail = _overlap_tail(body)
            current = [tail] if tail else []
            size = len(tail)
        current.append(unit)
        size += len(unit) + 2

    if current:
        chunks.append("\n\n".join(current))

    return [f"{header}\n{c}" for c in chunks]


def chunk_transcript(segments: list[dict], header: str) -> list[str]:
    """Trocea una transcripcion por ventanas de tiempo con solape.

    `segments` son dicts {text, start, duration}. Se acumulan hasta llenar el
    presupuesto de caracteres; la ventana siguiente retrocede un 15% de la
    DURACION de la anterior, no un 15% de sus caracteres. Asi el solape es
    constante en tiempo aunque el ritmo del habla cambie.

    Cada chunk lleva su rango temporal en la cabecera, para poder citarlo.
    """
    if not segments:
        return []

    chunks: list[str] = []
    i = 0
    n = len(segments)

    while i < n:
        start_time = segments[i].get("start", 0.0)
        texts: list[str] = []
        size = 0
        j = i

        while j < n and size < TARGET_CHARS:
            t = (segments[j].get("text") or "").strip()
            if t:
                texts.append(t)
                size += len(t) + 1
            j += 1

        last = segments[j - 1]
        end_time = last.get("start", 0.0) + last.get("duration", 0.0)

        if texts:
            stamp = f"[{_hms(start_time)}-{_hms(end_time)}]"
            chunks.append(f"{header} {stamp}\n" + " ".join(texts))

        if j >= n:
            break

        # Retrocede el 15% de la ventana en segundos.
        rewind_to = end_time - (end_time - start_time) * OVERLAP_RATIO
        next_i = j
        for k in range(i, j):
            if segments[k].get("start", 0.0) >= rewind_to:
                next_i = k
                break
        i = max(next_i, i + 1)

    return chunks


def _split_long(paragraph: str, limit: int) -> list[str]:
    if len(paragraph) <= limit:
        return [paragraph]

    sentences = re.split(r"(?<=[.!?])\s+", paragraph)
    out: list[str] = []
    buf = ""
    for s in sentences:
        if buf and len(buf) + len(s) + 1 > limit:
            out.append(buf)
            buf = s
        else:
            buf = f"{buf} {s}".strip()
    if buf:
        out.append(buf)

    # Una frase sola mas larga que el limite: corte duro.
    final: list[str] = []
    for piece in out:
        while len(piece) > limit:
            final.append(piece[:limit])
            piece = piece[limit:]
        if piece:
            final.append(piece)
    return final


def _overlap_tail(body: str) -> str:
    """Ultimo ~15% del chunk, cortado en frontera de palabra."""
    want = int(len(body) * OVERLAP_RATIO)
    if want < 50:
        return ""
    tail = body[-want:]
    space = tail.find(" ")
    return tail[space + 1 :] if space != -1 else tail


def _hms(seconds: float) -> str:
    total = int(seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:d}:{s:02d}"
