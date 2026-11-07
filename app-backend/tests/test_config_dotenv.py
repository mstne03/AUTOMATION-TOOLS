"""APP_BACKEND_SIN_DOTENV=1: ni `.env` ni `.env.local` tocan el entorno (E2E sin claves reales)."""


from app_backend import config


def test_sin_dotenv_no_carga_nada(tmp_path, monkeypatch):
    (tmp_path / ".env.local").write_text("CLAVE_DE_PRUEBA_DOTENV=real\n", encoding="utf-8")
    monkeypatch.delenv("CLAVE_DE_PRUEBA_DOTENV", raising=False)
    monkeypatch.setenv("APP_BACKEND_SIN_DOTENV", "1")
    assert config.cargar_dotenv(tmp_path) is False
    import os

    assert "CLAVE_DE_PRUEBA_DOTENV" not in os.environ


def test_con_dotenv_por_defecto_carga_env_local(tmp_path, monkeypatch):
    import os

    (tmp_path / ".env").write_text("CLAVE_DE_PRUEBA_DOTENV=base\n", encoding="utf-8")
    (tmp_path / ".env.local").write_text("CLAVE_DE_PRUEBA_DOTENV=local\n", encoding="utf-8")
    monkeypatch.delenv("APP_BACKEND_SIN_DOTENV", raising=False)
    monkeypatch.setenv("CLAVE_DE_PRUEBA_DOTENV", "x")  # monkeypatch restaura al salir
    assert config.cargar_dotenv(tmp_path) is True
    assert os.environ["CLAVE_DE_PRUEBA_DOTENV"] == "local"
