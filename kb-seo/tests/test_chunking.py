"""Tests de troceado. No necesitan ni base de datos ni Ollama."""

from itertools import pairwise

from kb import chunking


def test_cabecera_de_contexto():
    header = chunking.context_header("Mi titulo", ["youtube", "general"], "2025-01-15")
    assert header == "[Mi titulo | youtube, general | 2025-01-15]"


def test_cabecera_sin_datos():
    assert chunking.context_header(None, [], None) == "[Sin titulo | general | sin fecha]"


def test_cada_chunk_lleva_la_cabecera():
    texto = "\n\n".join(f"Parrafo numero {i}. " * 40 for i in range(12))
    chunks = chunking.chunk_text(texto, "[T | youtube | 2025-01-01]")
    assert len(chunks) > 1
    assert all(c.startswith("[T | youtube | 2025-01-01]\n") for c in chunks)


def test_los_chunks_no_se_pasan_mucho_del_objetivo():
    texto = "\n\n".join(f"Parrafo {i}. " * 50 for i in range(20))
    chunks = chunking.chunk_text(texto, "[H]")
    # Margen por la cabecera y por no cortar parrafos a la mitad.
    assert all(len(c) < chunking.TARGET_CHARS * 1.6 for c in chunks)


def test_hay_solape_entre_chunks_consecutivos():
    texto = "\n\n".join(f"Parrafo distinto numero {i} con relleno. " * 30 for i in range(10))
    chunks = chunking.chunk_text(texto, "[H]")
    assert len(chunks) >= 2
    # El final del primero debe reaparecer al principio del segundo.
    cola = chunks[0][-200:].split()[-8:]
    assert " ".join(cola) in chunks[1]


def test_parrafo_gigante_se_parte():
    gigante = "Una frase larguisima sin puntos y sin saltos " * 300
    chunks = chunking.chunk_text(gigante, "[H]")
    assert len(chunks) > 1


def test_texto_vacio_no_da_chunks():
    assert chunking.chunk_text("", "[H]") == []
    assert chunking.chunk_text("   \n\n  ", "[H]") == []


# ------------------------------------------------------- transcripciones


def _segmentos(n: int, texto: str = "palabra " * 12) -> list[dict]:
    return [{"text": texto.strip(), "start": i * 3.0, "duration": 3.0} for i in range(n)]


def test_transcripcion_vacia():
    assert chunking.chunk_transcript([], "[H]") == []


def test_transcripcion_corta_da_un_chunk():
    chunks = chunking.chunk_transcript(_segmentos(3), "[H]")
    assert len(chunks) == 1
    assert chunks[0].startswith("[H] [0:00-0:09]")


def test_transcripcion_larga_se_trocea_con_marca_de_tiempo():
    chunks = chunking.chunk_transcript(_segmentos(200), "[H]")
    assert len(chunks) > 1
    for c in chunks:
        assert c.startswith("[H] [")
        assert "-" in c.split("]")[1]


def test_las_ventanas_se_solapan_en_tiempo():
    """El inicio de cada ventana debe caer antes del final de la anterior."""
    chunks = chunking.chunk_transcript(_segmentos(200), "[H]")

    def rango(chunk: str) -> tuple[str, str]:
        stamp = chunk.split("[")[2].split("]")[0]
        return tuple(stamp.split("-"))

    def segundos(hms: str) -> int:
        parts = [int(p) for p in hms.split(":")]
        return parts[0] * 60 + parts[1] if len(parts) == 2 else parts[0] * 3600 + parts[1] * 60 + parts[2]

    rangos = [rango(c) for c in chunks]
    for (_, fin_anterior), (inicio, _) in pairwise(rangos):
        assert segundos(inicio) < segundos(fin_anterior), "las ventanas no se solapan"


def test_el_troceo_de_transcripcion_termina():
    """Regresion: el avance de ventana nunca debe quedarse parado."""
    segmentos = [{"text": "x", "start": 0.0, "duration": 0.0} for _ in range(500)]
    chunks = chunking.chunk_transcript(segmentos, "[H]")
    assert isinstance(chunks, list)
