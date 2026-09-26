"""Embeddings via Ollama (bge-m3, 1024 dimensiones, multilingue)."""

import time

import httpx

from kb import config

_BATCH_SIZE = 24          # dentro del rango 16-32 que pide la spec
_MAX_RETRIES = 4
_TIMEOUT = 180.0


def embed(texts: list[str]) -> list[list[float]]:
    """Devuelve un vector por texto, en el mismo orden.

    Trocea en lotes y reintenta con backoff exponencial ante errores de red
    o respuestas 5xx de Ollama.
    """
    if not texts:
        return []

    out: list[list[float]] = []
    with httpx.Client(timeout=_TIMEOUT) as client:
        for start in range(0, len(texts), _BATCH_SIZE):
            batch = texts[start : start + _BATCH_SIZE]
            out.extend(_embed_batch(client, batch))
    return out


def _embed_batch(client: httpx.Client, batch: list[str]) -> list[list[float]]:
    url = f"{config.OLLAMA_URL}/api/embed"
    payload = {"model": config.EMBED_MODEL, "input": batch}

    last_error: Exception | None = None
    for attempt in range(_MAX_RETRIES):
        try:
            response = client.post(url, json=payload)
            if response.status_code >= 500:
                raise httpx.HTTPStatusError(
                    f"Ollama devolvio {response.status_code}",
                    request=response.request,
                    response=response,
                )
            response.raise_for_status()
            vectors = response.json().get("embeddings")
            if not vectors or len(vectors) != len(batch):
                raise RuntimeError(
                    f"Ollama devolvio {len(vectors or [])} vectores para {len(batch)} textos"
                )
            for v in vectors:
                if len(v) != config.EMBED_DIM:
                    raise RuntimeError(
                        f"Dimension inesperada: {len(v)}, se esperaba {config.EMBED_DIM}. "
                        f"Revisa EMBED_MODEL={config.EMBED_MODEL}."
                    )
            return vectors
        except (httpx.HTTPError, RuntimeError) as e:
            last_error = e
            if attempt < _MAX_RETRIES - 1:
                time.sleep(2**attempt)

    raise RuntimeError(
        f"No se pudo obtener embeddings de Ollama en {config.OLLAMA_URL}. "
        f"Ultimo error: {last_error}. Comprueba que Ollama esta corriendo "
        f"y que tienes el modelo: ollama pull {config.EMBED_MODEL}"
    ) from last_error
