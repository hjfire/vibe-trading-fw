"""Regression: ``alpha compare`` must forward ``--data-source`` to the bench runner.

``warehouse`` is a fork-only loader source, so upstream's own CLI tests stub
``compare_alphas`` with a signature that predates it. These two pins keep the
routing honest: the flag reaches the runner when supplied, and an args
namespace without the attribute still resolves to ``None`` instead of raising.
"""

from __future__ import annotations

import argparse

import pytest

from src.factors import cli_handlers


class _FakeReg:
    def list(self, zoo=None):
        return ["alpha001", "alpha002"]


def _envelope():
    return {
        "status": "ok",
        "n_compared": 2,
        "n_skipped": 0,
        "winner": "alpha001",
        "ranking": [
            {
                "rank": 1,
                "id": "alpha001",
                "zoo": "alpha101",
                "ic_mean": 0.05,
                "ic_std": 0.01,
                "ir": 0.9,
                "ic_positive_ratio": 0.7,
                "ic_count": 100,
                "delta_ir_vs_best": 0.0,
            },
            {
                "rank": 2,
                "id": "alpha002",
                "zoo": "alpha101",
                "ic_mean": 0.03,
                "ic_std": 0.01,
                "ir": 0.6,
                "ic_positive_ratio": 0.6,
                "ic_count": 100,
                "delta_ir_vs_best": -0.3,
            },
        ],
    }


def _args(**overrides):
    base = dict(
        alpha_ids=["alpha001", "alpha002"],
        zoo=None,
        universe="csi300",
        period="2020-2025",
        sort="ir",
        compare_all=False,
    )
    base.update(overrides)
    return argparse.Namespace(**base)


@pytest.fixture()
def _captured(monkeypatch):
    """Replace the runner and the dotenv touch so only the routing is under test."""
    import src.providers.llm as llm

    calls: list[dict] = []

    def fake_compare(*args, **kwargs):
        calls.append(kwargs)
        return _envelope()

    monkeypatch.setattr(cli_handlers, "Registry", _FakeReg)
    monkeypatch.setattr(llm, "_ensure_dotenv", lambda: None)
    monkeypatch.setattr(cli_handlers, "compare_alphas", fake_compare)
    return calls


def test_compare_forwards_the_data_source_option(_captured):
    rc = cli_handlers.cmd_alpha_compare(_args(data_source="warehouse"))
    assert rc == 0
    assert len(_captured) == 1
    assert _captured[0]["data_source"] == "warehouse"


def test_compare_without_the_option_still_reaches_the_runner(_captured):
    """``argparse`` leaves the attribute off for callers that build a bare namespace."""
    rc = cli_handlers.cmd_alpha_compare(_args())
    assert rc == 0
    assert len(_captured) == 1
    assert _captured[0]["data_source"] is None
