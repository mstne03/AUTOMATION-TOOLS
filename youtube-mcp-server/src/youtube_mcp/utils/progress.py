"""Hook de progreso para las tools largas (subida, transcripcion).

Las tools no cambian de firma (su esquema JSON es el que ve el modelo): quien
las ejecuta como job fija un callback en el ContextVar antes de llamarlas.
``contextvars`` se propaga a ``asyncio.to_thread``, asi que funciona aunque la
tool corra en un hilo. Sin callback, ``report`` no hace nada.
"""

from contextvars import ContextVar
from typing import Callable

reporter: ContextVar[Callable[[float], None] | None] = ContextVar("progress_reporter", default=None)


def report(fraction: float) -> None:
    """Informa del progreso en [0, 1]."""
    cb = reporter.get()
    if cb is not None:
        cb(max(0.0, min(1.0, fraction)))
