"""Lookup ``SignalEngine`` for a Pine strategy exported by the TS engine.

The production backtest never re-implements Pine. Instead the TypeScript engine
runs the ``.pine`` strategy (including multi-timeframe ``request.security`` /
``request.security_lower_tf``) and exports a time-aligned signal artifact — see
``frontend/src/lib/pineSignal.ts``. This engine *looks that artifact up* and
hands the numbers to the ordinary backtest pipeline, so every market rule
(T+1, price limits, next-bar-open fills, the ``validation.py`` checks) still
applies exactly as it would for any hand-written ``SignalEngine``.

The executed path here is deliberately inert — no network, no env read, no file
write — so it clears ``runner._validate_signal_engine_source``: the per-symbol
artifact path is built from a module-level literal directory plus the symbol the
runner already passed in ``data_map``, read with ``pathlib`` (reads are allowed;
the scrubber only bars writes), and decoded with ``json``.

Alignment contract (the part a bridge can silently get wrong):
* The artifact's ``timestamps`` are the chart's epoch-ms, and ``wallClockZone``
  says how to turn them back into the loader's *timezone-naive* index — daily
  labels round-trip by identity (pandas reads a naive ``.timestamp()`` as UTC),
  intraday wall-clocks are converted at the market zone then stripped.
* ``signals`` is the strategy's **held direction** per bar. ``_align`` shifts the
  returned signal by one bar (next-bar-open), so we forward-shift the held
  series by one to hand over the *decision made at each bar's close*; after the
  engine's own shift the held positions line up bar-for-bar with the front end.
* Reindexed onto ``data_map[code].index``; bars the producer did not cover stay
  flat (0), a total calendar mismatch raises rather than trading a blank.
"""

import json
from pathlib import Path

import pandas as pd

#: Schema version this engine understands; a stale/future artifact is refused.
PINE_SIGNAL_SCHEMA = 1

#: Directory the per-symbol signal artifacts live in, relative to the run. The
#: headless producer writes ``<SIGNAL_DIR>/<code>.json`` for each symbol.
SIGNAL_DIR = "artifacts"


class SignalEngine:
    def generate(self, data_map: dict) -> dict:
        signals = {}
        for code, df in data_map.items():
            signals[code] = self._lookup(code, df)
        return signals

    def _lookup(self, code: str, df: pd.DataFrame) -> pd.Series:
        path = Path(SIGNAL_DIR) / f"{code}.json"
        if not path.exists():
            raise FileNotFoundError(
                f"no Pine signal artifact for '{code}' at {path!s}; run the "
                f"headless producer to export one before the backtest"
            )
        raw = json.loads(path.read_text(encoding="utf-8"))
        if raw.get("schema") != PINE_SIGNAL_SCHEMA:
            raise ValueError(
                f"artifact {path!s} has schema {raw.get('schema')!r}, "
                f"expected {PINE_SIGNAL_SCHEMA}"
            )
        held = pd.Series(
            [float(s) for s in raw["signals"]],
            index=self._reconstruct_index(raw["timestamps"], raw.get("wallClockZone")),
            dtype="float64",
        )
        held = held[~held.index.duplicated(keep="last")].sort_index()

        # Snap onto the loader's own calendar so `_align`'s reindex is a no-op
        # and any bar the producer never ran stays flat rather than dropped.
        reindexed = held.reindex(df.index)
        if len(df.index) > 0 and reindexed.isna().all():
            # Not one artifact timestamp matched a loader bar: the two calendars
            # do not overlap at all (wrong interval or wall-clock zone), so
            # refuse rather than backtest a blank book that looks like a result.
            raise ValueError(
                f"artifact {path!s} timestamps do not overlap '{code}' bars "
                f"(loader range {df.index.min()}..{df.index.max()}); check the "
                f"interval/wallClockZone used to export it"
            )
        held = reindexed.fillna(0.0)

        # held -> decision: one bar forward so the engine's shift(1) restores the
        # timing the front-end simulator filled on. Last bar has no next, so 0.
        decision = held.shift(-1).fillna(0.0)
        decision.name = "signal"
        return decision.clip(-1.0, 1.0)

    def _reconstruct_index(self, timestamps_ms: list, wall_clock_zone):
        ms = list(timestamps_ms)
        if wall_clock_zone:
            # Intraday: ms is a real instant; get the exchange wall clock back,
            # then drop the zone so it matches the loader's naive index.
            return (
                pd.to_datetime(pd.to_datetime(ms, unit="ms", utc=True))
                .tz_convert(wall_clock_zone)
                .tz_localize(None)
            )
        # Daily/weekly/monthly: the naive trading-day read as UTC, so a plain
        # ms->datetime (which assumes UTC) reproduces it exactly.
        return pd.to_datetime(ms, unit="ms")
