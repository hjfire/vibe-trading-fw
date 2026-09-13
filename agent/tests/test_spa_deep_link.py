"""Regression tests for the SPA deep-link middleware in ``api_server``.

The middleware intercepts browser navigation (``Accept: text/html``) to
SPA pages that share a path with an API endpoint, serving the SPA shell
instead. It must NOT intercept API-only paths even when called with a
text/html accept header — the matcher is intentionally narrow so things
like ``/runs/{id}/code`` and ``/runs/{id}/pine`` keep returning the
correct API response.
"""

from __future__ import annotations

import pytest


class TestSpaHtmlRouteMatcher:
    """Pin the matcher used by ``_spa_html_deep_link_fallback`` middleware."""

    @pytest.mark.parametrize(
        "path",
        [
            "/correlation",        # Correlation page
            "/runs/abc",           # RunDetail (no trailing slash)
            "/runs/abc-123",       # RunDetail with dashes
            "/runs/abc/",          # RunDetail (trailing slash)
        ],
    )
    def test_spa_pages_match(self, path: str) -> None:
        from api_server import _is_spa_html_route

        assert _is_spa_html_route(path) is True, path

    @pytest.mark.parametrize(
        "path",
        [
            "/runs",                # collection endpoint (API only)
            "/runs/abc/code",       # API-only — must NOT be hijacked
            "/runs/abc/pine",       # API-only — must NOT be hijacked
            "/runs/abc/code/",
            "/runs/abc/foo/bar",    # deeper nested — defensive
            "/sessions/xyz",        # different namespace
            "/api",
            "/skills",
            "/correlation/extra",   # only the bare /correlation page exists
        ],
    )
    def test_api_only_paths_do_not_match(self, path: str) -> None:
        from api_server import _is_spa_html_route

        assert _is_spa_html_route(path) is False, path


class TestApiNamespaceIsNeverAnsweredWithTheShell:
    """An unregistered ``/api/*`` must 404, not receive ``index.html``.

    Field evidence (local custom ㊱, second live-fire round): a page fetched
    ``/api/warehouse/status`` from a server that predated the route and got the
    shell at status **200**, so ``res.ok`` was true and the sole symptom was
    ``SyntaxError: Unexpected token '<', "<!doctype "... is not valid JSON``.
    Worse, the shell is served with ``ETag``/``Last-Modified`` and no
    ``Cache-Control``, so a browser keeps answering from its cache for hours —
    the page kept failing *after* the server had been fixed and restarted.
    """

    @staticmethod
    def _client(tmp_path):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from src.api.spa import SPAStaticFiles

        shell = tmp_path / "index.html"
        shell.write_text("<!doctype html><title>shell</title>", encoding="utf-8")

        app = FastAPI()

        @app.get("/api/registered")
        def registered():  # pragma: no cover - asserted to be reachable
            return {"ok": True}

        app.mount("/", SPAStaticFiles(directory=str(tmp_path), html=True), name="spa")
        return TestClient(app)

    def test_unregistered_api_path_is_a_404_not_the_shell(self, tmp_path) -> None:
        res = self._client(tmp_path).get("/api/never-registered")

        assert res.status_code == 404, res.text
        assert "text/html" not in res.headers["content-type"]

    def test_the_api_prefix_alone_is_not_a_page(self, tmp_path) -> None:
        # `/api` with no trailing segment is a navigation-shaped request, but
        # there is no such page: guessing at it must not fetch the shell either.
        res = self._client(tmp_path).get("/api/")

        assert res.status_code == 404, res.text

    def test_a_registered_api_route_is_untouched(self, tmp_path) -> None:
        res = self._client(tmp_path).get("/api/registered")

        assert res.status_code == 200
        assert res.json() == {"ok": True}

    def test_client_side_page_routes_still_get_the_shell(self, tmp_path) -> None:
        # The whole point of the fallback: a refresh on a route only the router
        # knows must still return the app, not a 404.
        res = self._client(tmp_path).get("/warehouse")

        assert res.status_code == 200
        assert "<title>shell</title>" in res.text
