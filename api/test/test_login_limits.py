"""Failed-login limiting, reset-link limiting and the server-side password policy.

Run from api/ with a .env (e.g. a copy of env.default): python -m pytest test/test_login_limits.py
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from chalicelib.core import tenants

# core_dynamic checks the database at import time to decide whether to expose /signup.
tenants.tenants_exists_sync = lambda use_pool=False: True

from chalicelib.core import users, reset_password  # noqa: E402
from chalicelib.utils import attempt_limiter, smtp, email_helper  # noqa: E402
from routers import core, core_dynamic  # noqa: E402

EMAIL = "user@openreplay.com"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(attempt_limiter, "_redis", None)
    attempt_limiter._memory.clear()
    app = FastAPI()
    app.include_router(core_dynamic.public_app)
    app.include_router(core.public_app)
    return TestClient(app)


def login(client, password="wrong"):
    return client.post("/login", json={"email": EMAIL, "password": password})


def test_login_blocked_after_max_failures(client, monkeypatch):
    monkeypatch.setattr(users, "authenticate", lambda email, password: None)
    for _ in range(attempt_limiter.MAX_FAILURES):
        assert login(client).status_code == 401
    assert login(client).status_code == 429


def test_blocked_login_does_not_check_password(client, monkeypatch):
    calls = []
    monkeypatch.setattr(users, "authenticate", lambda email, password: calls.append(1))
    for _ in range(attempt_limiter.MAX_FAILURES + 5):
        login(client)
    assert len(calls) == attempt_limiter.MAX_FAILURES


def test_limit_is_per_email(client, monkeypatch):
    monkeypatch.setattr(users, "authenticate", lambda email, password: None)
    for _ in range(attempt_limiter.MAX_FAILURES):
        login(client)
    r = client.post("/login", json={"email": "other@openreplay.com", "password": "wrong"})
    assert r.status_code == 401


def test_success_resets_failures(client, monkeypatch):
    monkeypatch.setattr(users, "authenticate", lambda email, password: None)
    for _ in range(attempt_limiter.MAX_FAILURES - 1):
        login(client)
    attempt_limiter.reset("login", EMAIL)
    assert not attempt_limiter.is_blocked("login", EMAIL)
    login(client)
    assert not attempt_limiter.is_blocked("login", EMAIL)


def test_window_expiry(monkeypatch):
    monkeypatch.setattr(attempt_limiter, "_redis", None)
    attempt_limiter._memory.clear()
    now = [1000.0]
    monkeypatch.setattr(attempt_limiter.time, "time", lambda: now[0])
    for _ in range(attempt_limiter.MAX_FAILURES):
        attempt_limiter.record_failure("login", EMAIL)
    assert attempt_limiter.is_blocked("login", EMAIL)
    now[0] += attempt_limiter.WINDOW_SECONDS + 1
    assert not attempt_limiter.is_blocked("login", EMAIL)


def test_reset_link_requests_are_limited(client, monkeypatch):
    sent = []
    monkeypatch.setattr(smtp, "has_smtp", lambda: True)
    monkeypatch.setattr(users, "get_by_email_only", lambda email: {"userId": 1})
    monkeypatch.setattr(users, "generate_new_invitation", lambda user_id: "https://example/reset")
    monkeypatch.setattr(email_helper, "send_forgot_password", lambda **kwargs: sent.append(kwargs))
    responses = [client.post("/password/reset-link", json={"email": EMAIL}).json()
                 for _ in range(attempt_limiter.MAX_FAILURES + 3)]
    assert len(sent) == attempt_limiter.MAX_FAILURES
    # Same response whether or not the email was sent.
    assert all(r == responses[0] for r in responses)


@pytest.mark.parametrize("password,ok", [
    ("Aa1!aaaa", True),
    ("Correct-Horse-9", True),
    ("Aa1!aaa", False),  # too short
    ("aa1!aaaa", False),  # no uppercase
    ("AA1!AAAA", False),  # no lowercase
    ("Aa!aaaaa", False),  # no digit
    ("Aa1aaaaa", False),  # no special character
    ("", False),
])
def test_password_policy(password, ok):
    assert (users.password_policy_error(password) is None) == ok
