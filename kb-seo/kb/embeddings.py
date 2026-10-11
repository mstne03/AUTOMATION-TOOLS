"""Embeddings con backend intercambiable: fastembed (ONNX) u Ollama.

`embed(texts)` vectoriza pasajes (chunks del corpus, parrafos a puntuar) y
`embed_query(text)` vectoriza una pregunta. La distincion importa con los
modelos e5, que se entrenaron con los prefijos "query: " y "passage: "; sin
ellos la similitud pregunta-pasaje baja de forma apreciable. Para el resto de
modelos los prefijos son cadenas vacias.
"""

import atexit
import os
import threading
import time

import httpx

from kb import config

_BATCH_SIZE = 24          # dentro del rango 16-32 que pide la spec
_MAX_RETRIES = 4
_TIMEOUT = 180.0

_lock = threading.Lock()
_client: httpx.Client | None = None       # Ollama
_model = None                              # fastembed.TextEmbedding


def _prefixes() -> tuple[str, str]:
    """(prefijo de consulta, prefijo de pasaje) segun el modelo."""
    if "e5" in config.EMBED_MODEL.lower():
        return "query: ", "passage: "
    return "", ""


def embed_query(text: str) -> list[float]:
    """Vector de una pregunta, con el prefijo de consulta del modelo."""
    return _embed([_prefixes()[0] + text])[0]


def embed(texts: list[str]) -> list[list[float]]:
    """Un vector por pasaje, en el mismo orden, con el prefijo de pasaje del modelo."""
    if not texts:
        return []
    prefijo = _prefixes()[1]
    return _embed([prefijo + t for t in texts])


def _embed(texts: list[str]) -> list[list[float]]:
    if config.EMBED_BACKEND == "fastembed":
        return _embed_fastembed(texts)
    if config.EMBED_BACKEND == "ollama":
        return _embed_ollama(texts)
    raise RuntimeError(
        f"EMBED_BACKEND={config.EMBED_BACKEND!r} no es valido: usa 'fastembed' u 'ollama'."
    )


def _check_dim(vectors: list[list[float]], esperados: int) -> list[list[float]]:
    if len(vectors) != esperados:
        raise RuntimeError(f"Se obtuvieron {len(vectors)} vectores para {esperados} textos")
    for v in vectors:
        if len(v) != config.EMBED_DIM:
            raise RuntimeError(
                f"Dimension inesperada: {len(v)}, se esperaba {config.EMBED_DIM}. "
                f"Revisa EMBED_MODEL={config.EMBED_MODEL} y EMBED_DIM."
            )
    return vectors


# ------------------------------------------------------------------ fastembed


# fastembed no trae multilingual-e5-small de serie (solo el large, de 1 GB), pero
# el repo oficial de HF publica el ONNX. Se registra como modelo custom con la
# configuracion del modelo: mean pooling + normalizacion L2, 384 dimensiones.
_CUSTOM_MODELS = {
    "intfloat/multilingual-e5-small": {
        "dim": 384,
        "model_file": "onnx/model.onnx",
    },
}


def _get_model():
    """Carga el modelo ONNX una vez por proceso (descarga ~120 MB la primera vez)."""
    global _model
    with _lock:
        if _model is None:
            os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
            from fastembed import TextEmbedding
            from fastembed.common.model_description import ModelSource, PoolingType

            custom = _CUSTOM_MODELS.get(config.EMBED_MODEL)
            if custom:
                TextEmbedding.add_custom_model(
                    model=config.EMBED_MODEL,
                    pooling=PoolingType.MEAN,
                    normalization=True,
                    sources=ModelSource(hf=config.EMBED_MODEL),
                    **custom,
                )
            _model = TextEmbedding(
                model_name=config.EMBED_MODEL, cache_dir=config.EMBED_CACHE_DIR
            )
        return _model


def _embed_fastembed(texts: list[str]) -> list[list[float]]:
    model = _get_model()
    vectors = [v.tolist() for v in model.embed(texts, batch_size=_BATCH_SIZE)]
    return _check_dim(vectors, len(texts))


# --------------------------------------------------------------------- ollama


def _get_client() -> httpx.Client:
    """Un cliente por proceso: abrir uno por llamada cuesta una conexion TCP cada vez."""
    global _client
    with _lock:
        if _client is None:
            _client = httpx.Client(timeout=_TIMEOUT)
        return _client


@atexit.register
def _close_client() -> None:
    global _client
    with _lock:
        if _client is not None:
            _client.close()
            _client = None


def _embed_ollama(texts: list[str]) -> list[list[float]]:
    client = _get_client()
    out: list[list[float]] = []
    for start in range(0, len(texts), _BATCH_SIZE):
        batch = texts[start : start + _BATCH_SIZE]
        out.extend(_embed_batch(client, batch))
    return out


def _embed_batch(client: httpx.Client, batch: list[str]) -> list[list[float]]:
    """Un lote contra Ollama, con backoff exponencial ante red o 5xx."""
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
            return _check_dim(response.json().get("embeddings") or [], len(batch))
        except (httpx.HTTPError, RuntimeError) as e:
            last_error = e
            if attempt < _MAX_RETRIES - 1:
                time.sleep(2**attempt)

    raise RuntimeError(
        f"No se pudo obtener embeddings de Ollama en {config.OLLAMA_URL}. "
        f"Ultimo error: {last_error}. Comprueba que Ollama esta corriendo "
        f"y que tienes el modelo: ollama pull {config.EMBED_MODEL}"
    ) from last_error
