"""Rate limiter instance — imported by main.py and api/auth.py."""
from fastapi import Request
from slowapi import Limiter


def _client_ip(request: Request) -> str:
    """Return real client IP, honouring X-Real-IP set by nginx."""
    return (
        request.headers.get("X-Real-IP")
        or request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
        or (request.client.host if request.client else "unknown")
    )


limiter = Limiter(key_func=_client_ip)
