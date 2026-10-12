import os
import tempfile
from pathlib import Path

# statuspage を import する前に、テスト専用の SQLite を指定しておく
_tmp_dir = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{(_tmp_dir / 'test.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from statuspage.api import app  # noqa: E402
from statuspage.db import Base, engine  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_db():
    """テストごとにテーブルを作り直す（テスト同士が影響し合わないように）。"""
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
