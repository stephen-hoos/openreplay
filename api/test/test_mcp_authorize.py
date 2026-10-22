"""MCP browser authorization requires the confirmation code shown by the MCP client.

Run from api/ with a .env (e.g. a copy of env.default): python -m pytest test/test_mcp_authorize.py
"""
import hashlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import schemas
from chalicelib.core.mcp import authorizers, tracer
from chalicelib.utils.TimeUTC import TimeUTC
from routers.subs import mcp

USER_CODE = "ABCD-EFGH"
CHALLENGE = hashlib.sha256(b"ABCDEFGH").hexdigest()


@pytest.fixture
def stored(monkeypatch):
    calls = []
    monkeypatch.setattr(authorizers, "store_token_request", lambda data, cotext: calls.append(data))
    monkeypatch.setattr(tracer, "store_client_id", lambda **kwargs: None)
    return calls


@pytest.fixture
def client():
    app = FastAPI()

    @app.middleware("http")
    async def set_context(request, call_next):
        request.state.currentContext = schemas.CurrentContext(tenantId=1, userId=1, email="user@openreplay.com",
                                                              role="member")
        return await call_next(request)

    for dep in mcp.app.dependencies:
        app.dependency_overrides[dep.dependency] = lambda: None
    app.include_router(mcp.app)
    return TestClient(app)


def authorize(client, user_code, challenge=CHALLENGE):
    return client.post("/v1/mcp/authorize", json={"state": "s" * 64, "clientId": "c" * 32,
                                                  "userCode": user_code, "codeChallenge": challenge})


@pytest.mark.parametrize("code", [USER_CODE, "abcd-efgh", "ABCDEFGH", " abcd efgh "])
def test_matching_code_is_accepted(client, stored, code):
    assert authorize(client, code).json() == {"data": {"success": True}}
    assert len(stored) == 1


def test_wrong_code_is_rejected(client, stored):
    body = authorize(client, "ABCD-EFGX").json()
    assert "errors" in body and stored == []


def test_missing_code_is_rejected(client, stored):
    r = client.post("/v1/mcp/authorize", json={"state": "s" * 64, "clientId": "c" * 32})
    assert r.status_code == 422 and stored == []


class _Cursor:
    def __init__(self, row):
        self.row = row

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def mogrify(self, query, params):
        return query

    def execute(self, query):
        pass

    def fetchone(self):
        return self.row


@pytest.mark.parametrize("age_s,expired", [(10, False), (authorizers.MCP_LOGIN_TIMEOUT_S + 60, True)])
def test_token_collection_timeout(monkeypatch, age_s, expired):
    row = {"user_id": 1, "tenant_id": 1, "jti": "j", "iat": TimeUTC.now() // 1000 - age_s}
    monkeypatch.setattr(authorizers.pg_client, "PostgresClient", lambda: _Cursor(row))
    monkeypatch.setattr(authorizers, "generate_jwt", lambda **kwargs: "token")
    if expired:
        with pytest.raises(Exception) as e:
            authorizers.get_token_by_state(client_id="c", state="s")
        assert getattr(e.value, "status_code", None) == 408
    else:
        assert authorizers.get_token_by_state(client_id="c", state="s") == "token"
