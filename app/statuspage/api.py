"""Web API とステータスページ。

起動方法: uvicorn statuspage.api:app
"""

from collections.abc import Iterator
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, ConfigDict, Field, HttpUrl
from sqlalchemy import select
from sqlalchemy.orm import Session

from statuspage.db import Check, SessionLocal, Target, init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()  # 起動時にテーブルを用意する
    yield


app = FastAPI(title="StatusPage", lifespan=lifespan)
templates = Jinja2Templates(directory=Path(__file__).parent / "templates")


def get_session() -> Iterator[Session]:
    """リクエストごとに DB セッションを開き、終わったら閉じる。"""
    with SessionLocal() as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]


# ---- 入出力の形（スキーマ） -------------------------------------------------


class TargetIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    url: HttpUrl  # http:// または https:// で始まる正しい URL だけを受け付ける


class CheckOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    checked_at: datetime
    ok: bool
    status_code: int | None
    response_ms: int | None
    error: str | None


class TargetOut(BaseModel):
    id: int
    name: str
    url: str
    latest: CheckOut | None  # まだ一度もチェックしていなければ None


def latest_check(session: Session, target_id: int) -> Check | None:
    stmt = (
        select(Check)
        .where(Check.target_id == target_id)
        .order_by(Check.checked_at.desc(), Check.id.desc())
        .limit(1)
    )
    return session.scalars(stmt).first()


def to_out(session: Session, target: Target) -> TargetOut:
    latest = latest_check(session, target.id)
    return TargetOut(
        id=target.id,
        name=target.name,
        url=target.url,
        latest=CheckOut.model_validate(latest) if latest else None,
    )


# ---- エンドポイント ----------------------------------------------------------


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """アプリが生きているかだけを返す（Phase 4 で ALB のヘルスチェックに使う）。"""
    return {"status": "ok"}


@app.get("/api/targets")
def list_targets(session: SessionDep) -> list[TargetOut]:
    targets = session.scalars(select(Target).order_by(Target.id)).all()
    return [to_out(session, t) for t in targets]


@app.post("/api/targets", status_code=201)
def create_target(body: TargetIn, session: SessionDep) -> TargetOut:
    target = Target(name=body.name, url=str(body.url))
    session.add(target)
    session.commit()
    session.refresh(target)
    return to_out(session, target)


@app.delete("/api/targets/{target_id}", status_code=204)
def delete_target(target_id: int, session: SessionDep) -> None:
    target = session.get(Target, target_id)
    if target is None:
        raise HTTPException(status_code=404, detail="target not found")
    session.delete(target)
    session.commit()


@app.get("/api/targets/{target_id}/checks")
def list_checks(
    target_id: int,
    session: SessionDep,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
) -> list[CheckOut]:
    if session.get(Target, target_id) is None:
        raise HTTPException(status_code=404, detail="target not found")
    stmt = (
        select(Check)
        .where(Check.target_id == target_id)
        .order_by(Check.checked_at.desc(), Check.id.desc())
        .limit(limit)
    )
    return [CheckOut.model_validate(c) for c in session.scalars(stmt)]


@app.get("/", response_class=HTMLResponse)
def status_page(request: Request, session: SessionDep):
    return templates.TemplateResponse(request, "index.html", {"targets": list_targets(session)})
