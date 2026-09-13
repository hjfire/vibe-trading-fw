"""Static-file serving rules for the bundled single-page application."""

from __future__ import annotations

from typing import Any

from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException


class SPAStaticFiles(StaticFiles):
    """Serve index.html for browser refreshes on client-side routes."""

    async def get_response(self, path: str, scope: dict[str, Any]):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404:
                raise
            if _is_api_namespace(path, scope):
                # The API namespace never gets the shell. Answering an unregistered
                # ``/api/...`` with index.html turns a missing route into a *200*
                # whose body is HTML, so a client's ``res.ok`` is true and the only
                # symptom is ``SyntaxError: Unexpected token '<'`` in the browser --
                # and the shell arrives with ETag/Last-Modified and no
                # Cache-Control, which lets caches keep that wrong answer for hours
                # after the server itself has been fixed. Letting the 404 through
                # costs nothing: no API route is supposed to be a file on disk.
                raise
            return await super().get_response("index.html", scope)


def _is_api_namespace(path: str, scope: dict[str, Any]) -> bool:
    """Whether this request targets the API namespace rather than a page route.

    Checks both shapes because a mount may hand over the full path or the remainder
    below its own prefix.
    """
    candidates = (str(scope.get("path") or ""), str(path or ""))
    return any(raw.lstrip("/").startswith("api/") for raw in candidates)
