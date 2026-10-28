"""Descarga el modelo de embeddings al directorio que empaqueta PyInstaller.

    uv run python scripts/fetch_model.py            # -> app-backend/models/multilingual-e5-small

Solo los ficheros que fastembed necesita (config, tokenizer y el ONNX). Es idempotente:
si ya estan, no vuelve a bajarlos. `app-backend.spec` copia el directorio al bundle y
`app_backend.config` apunta EMBED_MODEL_PATH a el cuando el binario esta congelado.
"""

import sys
from pathlib import Path

from huggingface_hub import snapshot_download

REPO = "intfloat/multilingual-e5-small"
# Commit fijado: la rama main del repo de Hugging Face puede cambiar y el binario empaquetaría
# un modelo distinto (u hostil) sin que nada lo note. Para actualizarlo, cambia el commit a mano.
REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"
FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model.onnx"]
DEST = Path(__file__).resolve().parent.parent / "models" / "multilingual-e5-small"


def main() -> int:
    DEST.mkdir(parents=True, exist_ok=True)
    snapshot_download(REPO, revision=REVISION, allow_patterns=FILES, local_dir=DEST)
    faltan = [f for f in FILES if not (DEST / f).is_file()]
    if faltan:
        print(f"Faltan ficheros del modelo: {faltan}", file=sys.stderr)
        return 1
    mb = sum((DEST / f).stat().st_size for f in FILES) / 1e6
    print(f"Modelo listo en {DEST} ({mb:.0f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
