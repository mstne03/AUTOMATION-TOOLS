"""Tests del formateo compacto. No necesitan base de datos ni Ollama."""

from kb import formatting


def _frag(doc_id, idx, content, score=0.1, title="Doc", url="http://x", fecha="2026-01-01"):
    return {
        "content": content, "title": title, "url": url, "author": "A",
        "published_at": fecha, "platforms": ["youtube"], "score": score,
        "document_id": doc_id, "chunk_index": idx,
    }


# --------------------------------------------------------------- cabeceras


def test_quita_la_cabecera_de_la_ingesta():
    c = "[Mi titulo | youtube | 2025-01-15]\nTexto de verdad."
    assert formatting.quitar_cabecera(c) == "Texto de verdad."


def test_quita_tambien_la_marca_de_tiempo_de_transcripcion():
    c = "[Mi titulo | youtube | 2025-01-15] [0:00-1:30]\nHola que tal."
    assert formatting.quitar_cabecera(c) == "Hola que tal."


def test_no_toca_texto_sin_cabecera():
    assert formatting.quitar_cabecera("Texto suelto.") == "Texto suelto."


# ----------------------------------------------------------------- solape


def test_detecta_el_solape():
    a = "uno dos tres cuatro cinco seis siete ocho nueve diez"
    b = "cinco seis siete ocho nueve diez once doce trece"
    n = formatting.solape(a, b)
    assert n > 0
    assert a.endswith(b[:n])


def test_sin_solape_devuelve_cero():
    assert formatting.solape("aaaa bbbb cccc", "zzzz yyyy xxxx") == 0


# ---------------------------------------------------------------- recorte


def test_recorta_en_frase_completa():
    texto = "Primera frase larga de relleno. Segunda frase. Tercera frase que sobra."
    out = formatting.recortar(texto, 50)
    assert len(out) <= 50
    assert out.endswith(".")


def test_sin_max_chars_no_recorta():
    texto = "x" * 5000
    assert formatting.recortar(texto, None) == texto


def test_texto_mas_corto_que_el_limite_se_deja_igual():
    assert formatting.recortar("corto.", 600) == "corto."


# --------------------------------------------------------------- agrupado


def test_funde_fragmentos_contiguos_del_mismo_documento():
    a = "[H]\nuno dos tres cuatro cinco seis siete ocho nueve diez"
    b = "[H]\ncinco seis siete ocho nueve diez once doce trece catorce"
    grupos = formatting.agrupar([_frag(1, 0, a, 0.2), _frag(1, 1, b, 0.1)])

    assert len(grupos) == 1, "dos contiguos deberian dar un bloque"
    texto = grupos[0]["content"]
    assert grupos[0]["fragmentos"] == 2
    assert texto.count("cinco seis siete") == 1, "el solape sigue repetido"
    assert "once doce trece" in texto, "se perdio el texto nuevo"


def test_no_funde_fragmentos_no_contiguos():
    grupos = formatting.agrupar([
        _frag(1, 0, "[H]\nprimero"),
        _frag(1, 5, "[H]\nlejano"),
    ])
    assert len(grupos) == 2


def test_no_funde_documentos_distintos():
    grupos = formatting.agrupar([
        _frag(1, 0, "[H]\nuno"),
        _frag(2, 1, "[H]\ndos"),
    ])
    assert len(grupos) == 2


def test_los_grupos_salen_ordenados_por_score():
    grupos = formatting.agrupar([
        _frag(1, 0, "[H]\nbajo", score=0.05),
        _frag(2, 0, "[H]\nalto", score=0.90),
    ])
    assert grupos[0]["content"] == "alto"


# ---------------------------------------------------------------- salida


def test_cabecera_de_una_sola_linea():
    salida = formatting.formatear(
        [_frag(1, 0, "[H]\nTexto.", title="Titulo", url="http://u", fecha="2026-05-05")],
        "consulta",
    )
    assert "[1] Titulo | 2026-05-05 | http://u" in salida
    assert "Autor:" not in salida
    assert "Plataformas:" not in salida
    assert "[H]" not in salida


def test_aplica_max_chars_por_bloque():
    largo = "Frase de relleno numero uno. " * 60
    salida = formatting.formatear([_frag(1, 0, f"[H]\n{largo}")], "q", max_chars=200)
    cuerpo = salida.split("\n", 2)[2]
    assert len(cuerpo) < 300
