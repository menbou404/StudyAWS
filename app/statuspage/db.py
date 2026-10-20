"""データベースの接続とテーブル定義。"""

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker

from statuspage.config import DATABASE_URL

# プールは接続を再利用するため、待機中に DB が再起動すると次の使用時まで気づかず、最初のリクエストが失敗する。
# Phase 3 の RDS 再起動・フェイルオーバーに備え、pool_pre_ping で貸し出し前に軽量な確認を送り、切断済みなら再接続する。
# 確認のために小さな追加の往復通信が発生する。
engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(engine)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Target(Base):
    """監視対象のサイト。"""

    __tablename__ = "targets"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    url: Mapped[str] = mapped_column(String(2048))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    checks: Mapped[list["Check"]] = relationship(
        back_populates="target", cascade="all, delete-orphan"
    )


class Check(Base):
    """1回分の監視結果。"""

    __tablename__ = "checks"

    id: Mapped[int] = mapped_column(primary_key=True)
    target_id: Mapped[int] = mapped_column(ForeignKey("targets.id", ondelete="CASCADE"), index=True)
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    ok: Mapped[bool]
    status_code: Mapped[int | None]
    response_ms: Mapped[int | None]
    error: Mapped[str | None] = mapped_column(Text)

    target: Mapped[Target] = relationship(back_populates="checks")


def init_db() -> None:
    """テーブルがなければ作る（既にあれば何もしない）。"""
    Base.metadata.create_all(engine)
