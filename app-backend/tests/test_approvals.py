import asyncio

import pytest

from app_backend.approvals import Approvals


async def test_approve_resolves_waiter():
    aps = Approvals()
    ap = aps.create("youtube_update_video", {"video_id": "v1"}, "write", {"bucket": "general", "cost": 50})
    waiter = asyncio.create_task(aps.wait(ap))
    await asyncio.sleep(0)
    assert [a.id for a in aps.pending()] == [ap.id]
    aps.resolve(ap.id, "approve")
    assert await waiter is True
    assert ap.status == "approved" and aps.pending() == []


async def test_reject():
    aps = Approvals()
    ap = aps.create("youtube_update_video", {}, "write", None)
    waiter = asyncio.create_task(aps.wait(ap))
    aps.resolve(ap.id, "reject")
    assert await waiter is False


async def test_destructive_requires_matching_video_id():
    aps = Approvals()
    ap = aps.create("youtube_delete_video", {"video_id": "abc"}, "destructive", None)
    with pytest.raises(ValueError, match="confirm_id"):
        aps.resolve(ap.id, "approve")
    with pytest.raises(ValueError, match="confirm_id"):
        aps.resolve(ap.id, "approve", confirm_id="otro")
    assert ap.status == "pending"
    aps.resolve(ap.id, "approve", confirm_id="abc")
    assert ap.status == "approved"
    assert ap.to_dict()["requires_confirm_id"] is True


async def test_cannot_resolve_twice_or_unknown():
    aps = Approvals()
    ap = aps.create("t", {}, "write", None)
    aps.resolve(ap.id, "reject")
    with pytest.raises(ValueError, match="ya esta rejected"):
        aps.resolve(ap.id, "approve")
    with pytest.raises(KeyError):
        aps.resolve("nope", "approve")
    with pytest.raises(ValueError, match="decision"):
        aps.resolve(aps.create("t", {}, "write", None).id, "maybe")


async def test_cancelled_wait_marks_cancelled():
    aps = Approvals()
    ap = aps.create("t", {}, "write", None)
    waiter = asyncio.create_task(aps.wait(ap))
    await asyncio.sleep(0)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert ap.status == "cancelled"
