"""Fixed-window limit on failed attempts per key (e.g. login email), to slow down password guessing.

Uses Redis when REDIS_STRING is set so the limit holds across API replicas, and falls back to
process memory otherwise. Keys are hashed so emails are not stored in Redis in clear text.
"""
import hashlib
import logging
import threading
import time

import redis
from decouple import config

logger = logging.getLogger(__name__)

MAX_FAILURES = config("LOGIN_MAX_FAILED_ATTEMPTS", cast=int, default=10)
WINDOW_SECONDS = config("LOGIN_FAILED_ATTEMPTS_WINDOW_S", cast=int, default=900)

_redis = None
_redis_url = config("REDIS_STRING", default="")
if _redis_url:
    try:
        _redis = redis.from_url(_redis_url, socket_timeout=2)
    except Exception as e:
        logger.warning(f"attempt limiter: invalid REDIS_STRING, using in-memory counters: {e}")

_lock = threading.Lock()
_memory: dict[str, tuple[int, float]] = {}


def _key(scope: str, value: str) -> str:
    digest = hashlib.sha256(value.strip().lower().encode()).hexdigest()
    return f"or:attempts:{scope}:{digest}"


def _memory_count(key: str) -> int:
    count, expires = _memory.get(key, (0, 0))
    return count if expires > time.time() else 0


def is_blocked(scope: str, value: str) -> bool:
    key = _key(scope, value)
    if _redis is not None:
        try:
            return int(_redis.get(key) or 0) >= MAX_FAILURES
        except redis.RedisError as e:
            logger.warning(f"attempt limiter: redis unavailable, using in-memory counters: {e}")
    with _lock:
        return _memory_count(key) >= MAX_FAILURES


def record_failure(scope: str, value: str) -> None:
    key = _key(scope, value)
    if _redis is not None:
        try:
            pipe = _redis.pipeline()
            pipe.incr(key)
            pipe.expire(key, WINDOW_SECONDS, nx=True)
            pipe.execute()
            return
        except redis.RedisError as e:
            logger.warning(f"attempt limiter: redis unavailable, using in-memory counters: {e}")
    with _lock:
        count = _memory_count(key)
        expires = _memory[key][1] if count else time.time() + WINDOW_SECONDS
        _memory[key] = (count + 1, expires)


def reset(scope: str, value: str) -> None:
    key = _key(scope, value)
    if _redis is not None:
        try:
            _redis.delete(key)
            return
        except redis.RedisError as e:
            logger.warning(f"attempt limiter: redis unavailable, using in-memory counters: {e}")
    with _lock:
        _memory.pop(key, None)
