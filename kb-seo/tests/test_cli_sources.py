"""sources.yaml portable: rutas relativas y `ingest url` sin perder comentarios."""

from pathlib import Path

from ingest import cli

_YAML_CON_COMENTARIOS = """# Fuentes de la base de conocimiento. Este archivo es la fuente de verdad.
#
# Convencion sobre fechas: las paginas oficiales llevan la fecha de verificacion.

# ---------------------------------------------------------------- YouTube

- url: https://ejemplo.com/a
  type: web
  platforms: [youtube]
  published_at: 2026-01-01
"""


class TestResolveLocation:
    def test_relativa_cuelga_de_la_raiz_del_repo(self):
        assert cli.resolve_location("local", "fuentes/x.md") == str(cli.PROJECT_ROOT / "fuentes/x.md")

    def test_absoluta_se_respeta(self, tmp_path):
        ruta = str(tmp_path / "x.md")
        assert cli.resolve_location("local", ruta) == ruta

    def test_web_y_urls_no_se_tocan(self):
        assert cli.resolve_location("web", "https://ejemplo.com") == "https://ejemplo.com"
        assert cli.resolve_location("pdf", "https://ejemplo.com/p.pdf") == "https://ejemplo.com/p.pdf"

    def test_las_fuentes_locales_del_repo_existen(self):
        """Las cuatro capturas de sources.yaml deben resolverse en esta maquina."""
        for source in cli.load_sources():
            if source.get("type") == "local":
                assert Path(cli.resolve_location("local", source["url"])).is_file(), source["url"]


class TestAppendSource:
    def test_conserva_comentarios_y_anade_al_final(self, tmp_path, monkeypatch):
        destino = tmp_path / "sources.yaml"
        destino.write_text(_YAML_CON_COMENTARIOS, encoding="utf-8")
        monkeypatch.setattr(cli, "SOURCES_PATH", destino)

        nueva = {"url": "https://ejemplo.com/b", "type": "web", "platforms": ["tiktok"]}
        assert cli.append_source(nueva) is True

        texto = destino.read_text(encoding="utf-8")
        assert texto.startswith(_YAML_CON_COMENTARIOS)
        assert "# Convencion sobre fechas" in texto
        assert [s["url"] for s in cli.load_sources()] == [
            "https://ejemplo.com/a",
            "https://ejemplo.com/b",
        ]

    def test_url_repetida_no_toca_el_archivo(self, tmp_path, monkeypatch):
        destino = tmp_path / "sources.yaml"
        destino.write_text(_YAML_CON_COMENTARIOS, encoding="utf-8")
        monkeypatch.setattr(cli, "SOURCES_PATH", destino)

        assert cli.append_source({"url": "https://ejemplo.com/a", "type": "web"}) is False
        assert destino.read_text(encoding="utf-8") == _YAML_CON_COMENTARIOS

    def test_archivo_inexistente_se_crea_con_cabecera(self, tmp_path, monkeypatch):
        destino = tmp_path / "sources.yaml"
        monkeypatch.setattr(cli, "SOURCES_PATH", destino)

        cli.append_source({"url": "https://ejemplo.com/c", "type": "web"})
        texto = destino.read_text(encoding="utf-8")
        assert texto.startswith(cli._HEADER)
        assert cli.load_sources()[0]["url"] == "https://ejemplo.com/c"
