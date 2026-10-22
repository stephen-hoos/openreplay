"""Integration settings hold third-party credentials: only owners and admins may manage them.

Run from api/ with a .env (e.g. a copy of env.default): python -m pytest test/test_integration_roles.py
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from chalicelib.core import tenants

# core_dynamic checks the database at import time to decide whether to expose /signup.
tenants.tenants_exists_sync = lambda use_pool=False: True

import schemas  # noqa: E402
from chalicelib.core import webhook  # noqa: E402
from chalicelib.core.log_tools import datadog  # noqa: E402
from routers import core, core_dynamic  # noqa: E402

WEBHOOKS = [{"webhookId": 1, "name": "alerts", "type": "webhook",
             "endpoint": "https://hooks.example.test/secret", "authHeader": "Bearer secret"}]


def make_client(role):
    app = FastAPI()

    @app.middleware("http")
    async def set_context(request, call_next):
        request.state.currentContext = schemas.CurrentContext(tenantId=1, userId=1, email="user@openreplay.com",
                                                              role=role)
        return await call_next(request)

    for router in (core.app, core_dynamic.app):
        # Skip JWT and project authorization: the context above stands in for an authenticated user.
        for dep in router.dependencies:
            app.dependency_overrides[dep.dependency] = lambda: None
        app.include_router(router)
    return TestClient(app)


@pytest.fixture(autouse=True)
def fake_storage(monkeypatch):
    monkeypatch.setattr(datadog, "get_all", lambda tenant_id: [{"apiKey": "dd-secret"}])
    monkeypatch.setattr(webhook, "get_by_tenant", lambda tenant_id, replace_none=False: [dict(w) for w in WEBHOOKS])
    monkeypatch.setattr(webhook, "get_by_type", lambda tenant_id, webhook_type: [dict(w) for w in WEBHOOKS])
    monkeypatch.setattr(webhook, "delete", lambda tenant_id, webhook_id: {"data": {"state": "success"}})


@pytest.mark.parametrize("method,path", [
    ("get", "/integrations/datadog"),
    ("delete", "/webhooks/1"),
])
def test_member_cannot_manage_integrations(method, path):
    r = getattr(make_client("member"), method)(path)
    assert r.status_code == 401


@pytest.mark.parametrize("role", ["owner", "admin"])
@pytest.mark.parametrize("method,path", [
    ("get", "/integrations/datadog"),
    ("delete", "/webhooks/1"),
])
def test_admin_can_manage_integrations(role, method, path):
    r = getattr(make_client(role), method)(path)
    assert r.status_code == 200


@pytest.mark.parametrize("path", ["/webhooks", "/integrations/slack/channels", "/integrations/msteams/channels"])
def test_member_lists_without_secrets(path):
    data = make_client("member").get(path).json()["data"]
    assert data[0]["name"] == "alerts"
    assert "endpoint" not in data[0] and "authHeader" not in data[0]


@pytest.mark.parametrize("path", ["/webhooks", "/integrations/slack/channels"])
def test_admin_lists_with_secrets(path):
    data = make_client("admin").get(path).json()["data"]
    assert data[0]["endpoint"] == WEBHOOKS[0]["endpoint"]
