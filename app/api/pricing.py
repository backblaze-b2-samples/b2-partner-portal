"""Per-group pricing configuration for cost-view in usage reports."""
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.database import get_db
from app.rbac import SETTINGS_READ, SETTINGS_WRITE, require_permission

router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class PricingUpsert(BaseModel):
    group_label: str = ""
    price_per_tb: float = Field(ge=0)


class PricingResponse(BaseModel):
    group_id: str
    group_label: str
    price_per_tb: float
    updated_at: str


@router.get("", response_model=list[PricingResponse])
async def list_pricing(_=require_permission(SETTINGS_READ)):
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT * FROM group_pricing ORDER BY group_label, group_id"
        )
        rows = await cursor.fetchall()
    return [PricingResponse(
        group_id=r["group_id"], group_label=r["group_label"],
        price_per_tb=r["price_per_tb"], updated_at=r["updated_at"],
    ) for r in rows]


@router.put("/{group_id}", response_model=PricingResponse)
async def upsert_pricing(group_id: str, body: PricingUpsert,
                         _=require_permission(SETTINGS_WRITE)):
    now = _now()
    async with get_db() as db:
        await db.execute(
            """INSERT INTO group_pricing (group_id, group_label, price_per_tb, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(group_id) DO UPDATE SET
                   group_label  = excluded.group_label,
                   price_per_tb = excluded.price_per_tb,
                   updated_at   = excluded.updated_at""",
            [group_id, body.group_label, body.price_per_tb, now],
        )
    return PricingResponse(
        group_id=group_id, group_label=body.group_label,
        price_per_tb=body.price_per_tb, updated_at=now,
    )


@router.delete("/{group_id}")
async def delete_pricing(group_id: str, _=require_permission(SETTINGS_WRITE)):
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT group_id FROM group_pricing WHERE group_id=?", [group_id]
        )
        if not await cursor.fetchone():
            raise HTTPException(404, "Pricing config not found")
        await db.execute("DELETE FROM group_pricing WHERE group_id=?", [group_id])
    return {"message": "Deleted"}
