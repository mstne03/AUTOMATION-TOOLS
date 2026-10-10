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


def test_recorta_en_frase_completa_y_marca_el_corte():
    texto = "Primera frase larga de relleno. Segunda frase. Tercera frase que sobra."
    out = formatting.recortar(texto, 50)
    assert len(out) <= 50
    assert out.endswith(". […]")
    assert "Tercera" not in out


def test_sin_max_chars_no_recorta():
    texto = "x" * 5000
    assert formatting.recortar(texto, None) == texto


def test_texto_mas_corto_que_el_limite_se_deja_igual():
    assert formatting.recortar("corto.", 600) == "corto."


def _por_palabra(palabra):
    """Puntuador falso: 1 a los textos que contienen `palabra`, 0 al resto."""
    return lambda textos: [1.0 if palabra in t else 0.0 for t in textos]


_DOC = "\n\n".join([
    "Introduccion larga que no interesa. " * 4,
    "## Pasos generales\n\nUno, dos, tres y cuatro, contados con calma.",
    "## Senales\n\nLas senales que mas pesan son la retencion y los compartidos.",
    "Parrafo posterior sobre controles del espectador y otras cosas.",
    "Cierre del documento con relleno final. " * 4,
])


def test_el_recorte_se_centra_en_lo_mas_relevante():
    out = formatting.recortar(_DOC, 200, _por_palabra("pesan"))
    assert len(out) <= 200
    assert "Las senales que mas pesan" in out
    assert "## Senales" in out, "el titulo va pegado a su parrafo"
    assert out.startswith("[…] ") and out.endswith(" […]")
    assert "Introduccion" not in out


def test_el_recorte_amplia_hacia_los_lados():
    out = formatting.recortar(_DOC, 300, _por_palabra("pesan"))
    assert "Uno, dos, tres" in out or "controles del espectador" in out
    assert len(out) <= 300


def test_sin_corte_al_principio_no_pone_marca_delante():
    out = formatting.recortar(_DOC, 200, _por_palabra("Introduccion"))
    assert out.startswith("Introduccion")
    assert out.endswith(" […]")


def test_si_el_puntuador_falla_recorta_desde_el_principio():
    def roto(_):
        raise RuntimeError("Ollama caido")

    out = formatting.recortar(_DOC, 200, roto)
    assert out.startswith("Introduccion")
    assert len(out) <= 200


def test_un_parrafo_que_no_cabe_se_recorta_por_frases_relevantes():
    parrafo = "Relleno inicial sin interes. " * 10 + "La clave es el gancho. " + "Mas relleno. " * 10
    out = formatting.recortar(parrafo.strip(), 80, _por_palabra("gancho"))
    assert "La clave es el gancho." in out
    assert len(out) <= 80
    assert out.startswith("[…]") and out.endswith("[…]")


# --------------------------------------------------- cabecera del documento


_INICIO = (
    "# Titulo del documento\n\n"
    "> Capturado el 2026-09-27.\n"
    "> Original: https://ejemplo.com/pagina/\n"
    "> Se renderiza por JavaScript.\n"
    ">\n"
    "> Nota editorial.\n\n"
    "## Como funciona\n\nTexto util."
)


def test_limpiar_inicio_quita_titulo_y_blockquote():
    texto, original = formatting.limpiar_inicio(_INICIO)
    assert texto.startswith("## Como funciona")
    assert "Capturado" not in texto and "Titulo del documento" not in texto
    assert original == "https://ejemplo.com/pagina/"


def test_limpiar_inicio_sin_cabecera_no_toca_nada():
    assert formatting.limpiar_inicio("Texto normal.\n\n> cita") == ("Texto normal.\n\n> cita", None)


def test_la_cabecera_no_sale_ni_gasta_max_chars():
    salida = formatting.formatear(
        [_frag(1, 0, f"[H]\n{_INICIO}", url="C:/kb/fuentes/x.md")], "q", max_chars=60
    )
    assert "Capturado" not in salida
    assert "# Titulo del documento" not in salida
    assert "Texto util." in salida
    assert "| https://ejemplo.com/pagina/" in salida, "la url original va a la cabecera"
    assert "C:/kb/fuentes/x.md" not in salida


def test_sin_max_chars_devuelve_todo_menos_la_cabecera():
    salida = formatting.formatear([_frag(1, 0, f"[H]\n{_INICIO}")], "q")
    assert "## Como funciona\n\nTexto util." in salida
    assert "Capturado" not in salida


def test_el_blockquote_en_mitad_del_documento_se_conserva():
    salida = formatting.formatear([_frag(1, 3, "[H]\n> Esto es contenido.\n\nMas texto.")], "q")
    assert "> Esto es contenido." in salida


def test_usa_la_url_original_que_trae_la_busqueda():
    r = _frag(1, 2, "[H]\nTexto.", url="C:/kb/fuentes/x.md")
    r["url_original"] = "https://ejemplo.com/"
    salida = formatting.formatear([r], "q")
    assert "| https://ejemplo.com/" in salida


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


def test_la_fusion_conserva_el_salto_de_parrafo_en_la_frontera():
    a = "[H]\nParrafo uno con bastante texto de relleno para el solape."
    b = "[H]\ncon bastante texto de relleno para el solape.\n\n### Titulo\n\n- lista"
    texto = formatting.agrupar([_frag(1, 0, a), _frag(1, 1, b)])[0]["content"]
    assert texto == "Parrafo uno con bastante texto de relleno para el solape.\n\n### Titulo\n\n- lista"


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
