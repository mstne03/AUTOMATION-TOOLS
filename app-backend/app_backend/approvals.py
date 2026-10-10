"""Gate de aprobacion: toda tool write/destructive se propone y espera al usuario.

La salida del modelo es entrada no confiable: el agente no ejecuta nada que
escriba en YouTube hasta que llega `POST /approvals/{id}` con `approve`. Las
destructivas exigen ademas repetir el ID del video en `confirm_id`.
"""

import asyncio
import secrets
from dataclasses import dataclass, field


@dataclass
class Approval:
    id: str
    tool: str
    args: dict
    risk: str
    quota: dict | None
    status: str = "pending"  # pending | approved | rejected | cancelled
    _future: asyncio.Future = field(default_factory=lambda: asyncio.get_running_loop().create_future())

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "tool": self.tool,
            "args": self.args,
            "risk": self.risk,
            "quota": self.quota,
            "status": self.status,
            "requires_confirm_id": self.risk == "destructive",
        }


class Approvals:
    def __init__(self):
        self._items: dict[str, Approval] = {}

    def create(self, tool: str, args: dict, risk: str, quota: dict | None) -> Approval:
        ap = Approval(id=secrets.token_urlsafe(8), tool=tool, args=args, risk=risk, quota=quota)
        self._items[ap.id] = ap
        return ap

    async def wait(self, ap: Approval) -> bool:
        """True si se aprueba. Si la espera se cancela (chat cerrado), queda cancelada."""
        try:
            return await ap._future
        except asyncio.CancelledError:
            if ap.status == "pending":
                ap.status = "cancelled"
            raise

    def resolve(self, approval_id: str, decision: str, confirm_id: str | None = None) -> Approval:
        ap = self._items.get(approval_id)
        if ap is None:
            raise KeyError(approval_id)
        if ap.status != "pending":
            raise ValueError(f"La propuesta ya esta {ap.status}.")
        if decision not in ("approve", "reject"):
            raise ValueError("decision debe ser 'approve' o 'reject'.")
        if decision == "approve" and ap.risk == "destructive":
            esperado = str(ap.args.get("video_id", ""))
            if not esperado or confirm_id != esperado:
                raise ValueError("Accion destructiva: confirm_id debe repetir el video_id.")
        ap.status = "approved" if decision == "approve" else "rejected"
        if not ap._future.done():
            ap._future.set_result(ap.status == "approved")
        return ap

    def get(self, approval_id: str) -> Approval:
        return self._items[approval_id]

    def pending(self) -> list[Approval]:
        return [a for a in self._items.values() if a.status == "pending"]
