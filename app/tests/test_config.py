import pytest
from sqlalchemy.engine import make_url

from statuspage.config import build_database_url


def test_database_url_takes_precedence() -> None:
    env = {"DATABASE_URL": "sqlite:///override.db", "DB_HOST": "db.example"}
    assert build_database_url(env) == "sqlite:///override.db"
    assert build_database_url({"DATABASE_URL": ""}) == ""


def test_database_url_from_parts_with_defaults() -> None:
    url = make_url(build_database_url({"DB_HOST": "db.example", "DB_PASSWORD": "p@ss/w:rd%"}))
    assert url.drivername == "postgresql+psycopg"
    assert url.host == "db.example"
    assert url.port == 5432
    assert url.username == "statuspage"
    assert url.password == "p@ss/w:rd%"
    assert url.database == "statuspage"
    assert url.query == {"sslmode": "require"}


def test_database_url_from_custom_parts() -> None:
    url = make_url(build_database_url({
        "DB_HOST": "db.example",
        "DB_PORT": "5433",
        "DB_NAME": "custom",
        "DB_USER": "custom_user",
        "DB_PASSWORD": "p@ss/w:rd%",
        "DB_SSLMODE": "verify-full",
    }))
    assert url.port == 5433
    assert url.database == "custom"
    assert url.username == "custom_user"
    assert url.password == "p@ss/w:rd%"
    assert url.query == {"sslmode": "verify-full"}


@pytest.mark.parametrize("env", [
    {"DB_HOST": "db.example"},
    {"DB_HOST": "db.example", "DB_PASSWORD": ""},
])
def test_database_host_requires_password(env: dict[str, str]) -> None:
    with pytest.raises(ValueError, match="DB_PASSWORD"):
        build_database_url(env)


def test_database_url_defaults_to_sqlite() -> None:
    assert build_database_url({}) == "sqlite:///./dev.db"
