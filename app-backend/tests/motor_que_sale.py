"""Motor falso que sale con 70 por su cuenta, sin que nadie lo llame, cuando aparece el fichero que dice su argv[1]."""

import os
import sys
import threading
import time
from pathlib import Path

from motor_falso import mcp


def _vigilar(flag: Path) -> None:
    while not flag.exists():
        time.sleep(0.05)
    os._exit(70)


if __name__ == "__main__":
    threading.Thread(target=_vigilar, args=(Path(sys.argv[1]),), daemon=True).start()
    mcp.run()
