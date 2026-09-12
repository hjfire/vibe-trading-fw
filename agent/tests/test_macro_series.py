"""Tests for :mod:`backtest.macro_series` (iFinD EDB decode + local cache).

The primary fixtures under ``tests/fixtures/ifind/`` are verbatim replies
captured from the live endpoint, not hand-written shapes: a fixture typed from
memory would test my recollection of the payload instead of the payload. The
traps pinned here are the ones that actually exist in that data -- rows served
newest-first, a ``%`` unit that must not be divided out, ``\\t``-and-dash gap
markers that must not become 0.0, and an inline ``亿`` suffix that is part of
the number rather than decoration.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pandas as pd
import pytest

from backtest.macro_series import (
    CACHE_VERSION,
    IfindDecodeError,
    MacroSeries,
    extract_series,
    is_fresh,
    list_cached,
    load_series,
    normalize_date,
    parse_cell_number,
    record_to_series,
    save_series,
    series_from_markdown,
    slug_for,
    split_markdown_table,
    unwrap_envelope,
)

FIXTURES = Path(__file__).parent / "fixtures" / "ifind"

RETAIL_NAME = "全国:社会消费品零售总额:当月同比"


def _payload(name: str) -> dict:
    """Load one verbatim captured reply."""
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Envelope unwrapping
# ---------------------------------------------------------------------------


def test_envelope_reaches_the_triple_encoded_data() -> None:
    """The reply is envelope -> JSON string -> ``data`` -> table."""
    envelope = unwrap_envelope(_payload("edb_standard_table.json"))
    assert envelope["ok"] is True
    assert envelope["code"] == 1
    assert envelope["msg"] == "success"
    assert isinstance(envelope["data"], dict)
    assert set(envelope["data"]) >= {"answer", "datas"}


def test_plain_dict_body_is_accepted_without_an_envelope() -> None:
    """A caller that already unwrapped the MCP layer still decodes."""
    envelope = unwrap_envelope({"code": 1, "msg": "success", "data": {"answer": "|x|"}})
    assert envelope["ok"] is True


def test_adapter_level_error_payload_keeps_the_servers_reason() -> None:
    """``MCPServerAdapter.call_tool`` returns {status: error} instead of raising.

    Folding that into "code=None" would lose the one string that says whether
    to retry, re-key, or stop spending quota.
    """
    with pytest.raises(IfindDecodeError) as exc:
        unwrap_envelope({"status": "error", "error": "timed out connecting to ifind-edb"})
    assert "timed out connecting to ifind-edb" in str(exc.value)


def test_structured_content_only_reply_is_found_one_layer_deeper() -> None:
    """Some MCP servers answer with a dict and no text block at all."""
    envelope = unwrap_envelope(
        {"status": "ok", "data": {"code": 1, "msg": "success", "data": {"answer": "|x|"}}}
    )
    assert envelope["ok"] is True
    assert envelope["data"] == {"answer": "|x|"}


def test_non_success_code_raises_with_the_server_message() -> None:
    """Quota / auth failures surface as an error naming the server's reason.

    iFinD reports exhausted quota and rate limits through ``code``/``msg`` on an
    HTTP 200, so a caller that only checks transport success would loop on it.
    """
    with pytest.raises(IfindDecodeError) as exc:
        extract_series({"code": 0, "msg": "请求次数超过限额", "data": None})
    assert "请求次数超过限额" in str(exc.value)


def test_undecodable_reply_raises_rather_than_returning_empty() -> None:
    """Prose with no JSON anywhere is a decode failure, not a zero-row result."""
    with pytest.raises(IfindDecodeError):
        unwrap_envelope({"text": "connection reset by peer"})


# ---------------------------------------------------------------------------
# Structured table branch, against the real payload
# ---------------------------------------------------------------------------


def test_real_edb_payload_decodes_one_fully_attributed_series() -> None:
    """Index id, unit, frequency and publisher all come through."""
    series = extract_series(_payload("edb_standard_table.json"))
    assert len(series) == 1
    one = series[0]
    assert one.name == RETAIL_NAME
    assert one.index_id == "M001657195"
    assert one.unit == "%"
    assert one.freq == "M"
    assert one.data_source == "国家统计局"
    assert one.country == "中国"
    assert one.source == "structured"
    assert one.warnings == []
    assert len(one.dates) == 14
    assert len(one.values) == len(one.dates)


def test_values_keep_the_declared_unit_and_are_not_rescaled() -> None:
    """``unit='%'`` is recorded, never applied: 1.0 stays 1.0 percent."""
    one = extract_series(_payload("edb_standard_table.json"))[0]
    assert one.dates[0] == "2025-03-31"  # ascending, i.e. NOT served order
    assert one.dates[-1] == "2026-06-30"
    assert one.values[0] == pytest.approx(5.9)
    assert one.values[-1] == pytest.approx(1.0)
    assert one.values[-2] == pytest.approx(-0.6)  # a negative reading, kept as-is


def test_china_january_february_publication_hole_is_a_missing_date() -> None:
    """China reports retail sales for Jan+Feb combined, so 2026-01/02 do not exist.

    The decoder must leave them absent. Inventing a row (zero, or a copy of a
    neighbouring month) would manufacture a macro reading that was never
    published, and every month-over-month change after it would be wrong.
    """
    one = extract_series(_payload("edb_standard_table.json"))[0]
    months = {date[:7] for date in one.dates}
    assert "2026-01" not in months
    assert "2026-02" not in months
    assert len(one.dates) == 14
    # Every surviving stamp is its own month's last day.
    assert all(pd.Timestamp(date) == pd.Timestamp(date) + pd.offsets.MonthEnd(0)
               for date in one.dates)


def test_fixture_rows_arrive_newest_first() -> None:
    """Pin the served ordering that makes sorting load-bearing.

    If iFinD ever changes this, the assertion that fails is the loud one here,
    not a silently flipped sign in a momentum calculation two layers away.
    """
    raw = _payload("edb_standard_table.json")
    inner = unwrap_envelope(raw)["data"]["datas"][0]["data"]
    served = [row[0] for row in inner["data"]]
    assert served == sorted(served, reverse=True)
    assert served[0] == "2026-06-30"


def test_frame_is_ascending_so_period_over_period_keeps_its_sign() -> None:
    """A descending index would compute next-minus-previous, flipping the sign.

    Hand-checked from the real payload: 2026-04 (0.2) following 2026-03 (1.7) is
    a *deceleration*, so the first difference must be negative.
    """
    one = extract_series(_payload("edb_standard_table.json"))[0]
    frame = one.frame()
    assert frame.index.is_monotonic_increasing
    assert frame.index.name == "trade_date"
    diffs = frame["value"].diff().dropna()
    assert diffs[pd.Timestamp("2026-04-30")] == pytest.approx(0.2 - 1.7)
    assert diffs[pd.Timestamp("2026-04-30")] < 0
    assert frame.attrs["unit"] == "%"
    assert frame.attrs["index_id"] == "M001657195"


def test_frame_returns_are_negative_for_a_decelerating_tail() -> None:
    """The sign of ``pct_change`` is the whole point of sorting ascending.

    On the served (descending) order the same call would read 0.2 -> 1.7 as an
    acceleration. This asserts the direction against hand-computed numbers.
    """
    one = extract_series(_payload("edb_standard_table.json"))[0]
    rets = one.frame()["value"].pct_change(fill_method=None).dropna()
    # 2026-03-31 (1.7) -> 2026-04-30 (0.2): a deceleration, so negative.
    assert rets[pd.Timestamp("2026-04-30")] == pytest.approx((0.2 - 1.7) / 1.7)
    assert rets[pd.Timestamp("2026-04-30")] < 0
    # 2026-05-31 (-0.6) -> 2026-06-30 (1.0) crosses a sign flip: pct_change over
    # a negative base reads -2.67 for what was actually a rise. Recorded here so
    # the trap is documented in code, and the reason macro_regime.py works on
    # first differences instead of returns.
    assert rets[pd.Timestamp("2026-06-30")] == pytest.approx((1.0 - (-0.6)) / (-0.6))
    assert rets[pd.Timestamp("2026-06-30")] < 0  # wrong sign for a rising print
    # The difference form keeps the right sign across the same step.
    diffs = one.frame()["value"].diff().dropna()
    assert diffs[pd.Timestamp("2026-06-30")] == pytest.approx(1.0 - (-0.6))
    assert diffs[pd.Timestamp("2026-06-30")] > 0


def test_markdown_and_structured_branches_agree_on_the_same_data() -> None:
    """``data.answer`` is the same table as ``datas[].data``, in prose form.

    Decoding both and requiring agreement is the strongest check available
    offline: it validates the fallback path against ground truth without
    spending another request.
    """
    payload = _payload("edb_standard_table.json")
    structured = extract_series(payload)[0]
    answer = unwrap_envelope(payload)["data"]["answer"]
    markdown = series_from_markdown(answer)
    assert len(markdown) == 1
    assert markdown[0].name == structured.name
    assert markdown[0].dates == structured.dates
    assert markdown[0].values == structured.values
    # Header unit survives as metadata on the fallback path too.
    assert markdown[0].unit == "%"


def test_multi_indicator_table_yields_one_series_per_column() -> None:
    """Two indicators plus a date column produce two attributed series."""
    table = {
        "columns": ["日期", "A:同比", "B:环比"],
        "data": [["2026-02-28", 3.5, -0.1], ["2026-01-31", 2.5, 0.4]],
        "attrs": {
            "A:同比": {"unit": "%", "freq": "M", "index_id": "M0001"},
            "B:环比": {"unit": "%", "freq": "M", "index_id": "M0002"},
        },
    }
    payload = {"code": 1, "msg": "success", "data": {"datas": [{"success": True, "data": table}]}}
    series = extract_series(payload)
    assert [item.name for item in series] == ["A:同比", "B:环比"]
    assert [item.index_id for item in series] == ["M0001", "M0002"]
    assert series[0].dates == ["2026-01-31", "2026-02-28"]
    assert series[1].values == [0.4, -0.1]


def test_failed_block_is_surfaced_as_a_warning_not_silently_dropped() -> None:
    """``success=false`` still consumed quota; the caller must be able to see it."""
    payload = {
        "code": 1,
        "msg": "success",
        "data": {"datas": [{"success": False, "description": "提取数据：EDB-", "answer": "没有找到匹配的指标"}]},
    }
    series = extract_series(payload)
    assert len(series) == 1
    assert series[0].dates == []
    assert any("success=false" in note for note in series[0].warnings)


# ---------------------------------------------------------------------------
# Gap handling
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "cell",
    ["", "-", "--", "—", "\t", "None", "null", None, float("nan")],
)
def test_empty_and_placeholder_cells_are_gaps(cell: object) -> None:
    """None of them may become 0.0 -- that would be an economic statement."""
    value, unit, is_gap = parse_cell_number(cell)
    assert value is None
    assert is_gap is True
    assert unit is None


def test_gap_rows_are_kept_as_none_so_dates_stay_aligned() -> None:
    """Dropping a hole would silently compress the series onto the wrong days."""
    table = {
        "columns": ["日期", "X"],
        "data": [["2026-03-31", 1.0], ["2026-02-28", "\t"], ["2026-01-31", 3.0]],
        "attrs": {"X": {"unit": "%", "freq": "M"}},
    }
    one = extract_series({"code": 1, "data": {"datas": [{"success": True, "data": table}]}})[0]
    assert one.dates == ["2026-01-31", "2026-02-28", "2026-03-31"]
    assert one.values == [3.0, None, 1.0]


def test_duplicate_period_keeps_the_newest_rendition() -> None:
    """Rows are newest-first, so a repeated period is a restatement of it."""
    table = {
        "columns": ["日期", "X"],
        "data": [["2026-01-31", 9.9], ["2026-01-31", 1.0]],
        "attrs": {"X": {}},
    }
    one = extract_series({"code": 1, "data": {"datas": [{"success": True, "data": table}]}})[0]
    assert one.dates == ["2026-01-31"]
    assert one.values == [9.9]


def test_markdown_duplicate_period_keeps_the_newest_rendition() -> None:
    """The fallback branch serves the same order, so it needs the same rule.

    Restatements arrive as two rows for one period in every branch; sharing the
    ordering fact between branches is only real if both are held to it.
    """
    markdown = (
        "|日期|X|\n|---|---|\n"
        "|2026-01-31|9.9|\n|2026-01-31|1.0|\n|2025-12-31|0.9|"
    )
    one = series_from_markdown(markdown)[0]
    assert one.dates == ["2025-12-31", "2026-01-31"]
    assert one.values == [pytest.approx(0.9), pytest.approx(9.9)]


# ---------------------------------------------------------------------------
# Units
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "cell, expected, suffix",
    [
        ("44.3084亿", 44.3084e8, "亿"),
        ("1.2万亿", 1.2e12, "万亿"),
        ("3千亿", 3e11, "千亿"),
        ("500万", 5e6, "万"),
        ("-2.5亿", -2.5e8, "亿"),
        ("1,234.5", 1234.5, None),
        ("12", 12.0, None),
    ],
)
def test_inline_magnitude_suffixes_are_applied_to_the_number(
    cell: str, expected: float, suffix: str | None
) -> None:
    """In the markdown branch the suffix is part of the cell's value."""
    value, unit, is_gap = parse_cell_number(cell)
    assert is_gap is False
    assert value == pytest.approx(expected)
    assert unit == suffix


def test_inline_scaling_is_recorded_as_a_warning() -> None:
    """A scaled value must be distinguishable from a raw one after the fact."""
    markdown = "|日期|销售额|\n|---|---|\n|2026-06-30|44.3084亿|\n|2026-05-31|40亿|"
    one = series_from_markdown(markdown)[0]
    assert one.values == [pytest.approx(40e8), pytest.approx(44.3084e8)]
    assert any("亿" in note for note in one.warnings)


def test_header_unit_is_stripped_from_the_name_and_kept_as_metadata() -> None:
    """``基差率（%）（单位：%）`` names the column ``基差率（%）`` and says ``%``."""
    payload = _payload("markdown_table_with_units.json")
    answer = unwrap_envelope(payload)["data"]["answer"]
    headers, rows = split_markdown_table(answer)
    assert headers[0] == "证券代码"
    assert rows[0][2] == "3.6036"
    # No date column: this is a snapshot table, not a time series.
    assert series_from_markdown(answer) == []


@pytest.mark.parametrize(
    "header, expected_name, expected_unit",
    [
        ("基差率（%）（单位：%）", "基差率（%）", "%"),
        ("现货价格（单位：元）", "现货价格", "元"),
        ("涨跌幅", "涨跌幅", None),
    ],
)
def test_declared_units_are_recorded_without_moving_the_decimal_point(
    header: str, expected_name: str, expected_unit: str | None
) -> None:
    """The unit lives beside the number; it is never applied to it.

    Dividing a ``%``-quoted series by 100 because the header said so would be a
    100x caliber error, which is the class of bug this module exists to avoid.
    """
    markdown = f"|日期|{header}|\n|---|---|\n|2026-06-30|3.6036|"
    one = series_from_markdown(markdown)[0]
    assert one.name == expected_name
    assert one.unit == expected_unit
    assert one.values == [pytest.approx(3.6036)]


# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("2026-06-30", "2026-06-30"),
        ("2026/6/30", "2026-06-30"),
        ("20260630", "2026-06-30"),
        ("2026-06", "2026-06-30"),
        ("2026-1", "2026-01-31"),
        ("2026-06-30 00:00:00", "2026-06-30"),
        ("not a date", None),
        ("", None),
        (None, None),
    ],
)
def test_normalize_date(raw: object, expected: str | None) -> None:
    """Month-only stamps anchor at month end, never the 1st."""
    assert normalize_date(raw) == expected


# ---------------------------------------------------------------------------
# Prose replies (no table at all)
# ---------------------------------------------------------------------------


def test_prose_reply_decodes_to_no_series_without_raising() -> None:
    """``抱歉，本次新闻搜索结果为空`` is a *successful*, quota-spending call.

    Distinguishing "empty result" from "call failed" is what lets a caller avoid
    re-issuing a query that will simply cost another request.
    """
    payload = _payload("empty_result_string_data.json")
    assert extract_series(payload) == []


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the runtime root at a temp dir so tests never touch ~/.vibe-trading."""
    monkeypatch.setenv("VIBE_TRADING_HOME", str(tmp_path))
    return tmp_path


def _sample() -> MacroSeries:
    return MacroSeries(
        name=RETAIL_NAME,
        dates=["2026-01-31", "2026-02-28", "2026-03-31"],
        values=[1.7, None, 0.2],
        index_id="M001657195",
        unit="%",
        freq="M",
        data_source="国家统计局",
        country="中国",
    )


def test_cache_round_trip_preserves_every_field() -> None:
    """Save then load must not lose the gap, the unit, or the provenance."""
    path = save_series(_sample(), query="测试查询")
    assert path.is_file()
    record = load_series(path.stem)
    assert record is not None
    assert record["query"] == "测试查询"
    assert record["values"] == [1.7, None, 0.2]
    restored = record_to_series(record)
    assert restored.name == RETAIL_NAME
    assert restored.index_id == "M001657195"
    assert restored.unit == "%"
    assert restored.dates == ["2026-01-31", "2026-02-28", "2026-03-31"]
    assert restored.frame()["value"].isna().sum() == 1


def test_cache_file_is_utf8_and_readable_without_escape_soup() -> None:
    """Chinese labels stay legible on disk (``ensure_ascii=False`` discipline)."""
    path = save_series(_sample())
    text = path.read_text(encoding="utf-8")
    assert RETAIL_NAME in text
    assert "\\u" not in text


def test_corrupt_cache_is_a_miss_not_an_error() -> None:
    """A half-written file must not take down a research read."""
    path = save_series(_sample())
    path.write_text("{not json", encoding="utf-8")
    assert load_series(path.stem) is None
    assert list_cached() == []


def test_cache_from_a_different_version_is_ignored() -> None:
    """Layout changes must not be misread as data."""
    path = save_series(_sample())
    record = json.loads(path.read_text(encoding="utf-8"))
    record["version"] = CACHE_VERSION + 1
    path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    assert load_series(path.stem) is None


def test_list_cached_returns_an_index_with_range_and_age() -> None:
    save_series(_sample())
    rows = list_cached()
    assert len(rows) == 1
    row = rows[0]
    assert row["name"] == RETAIL_NAME
    assert row["count"] == 3
    assert row["first"] == "2026-01-31"
    assert row["last"] == "2026-03-31"
    assert row["fetched_at"]


def test_freshness_depends_on_the_series_frequency() -> None:
    """A daily series goes stale in hours; a monthly one need not be refetched daily.

    The asymmetry is the quota defence: the TTL is what stops a repeated
    research question from re-billing the 2000-request grant.
    """
    now = dt.datetime(2026, 9, 12, 12, 0, tzinfo=dt.timezone.utc)
    for freq, age, expected in [
        ("D", dt.timedelta(hours=1), True),
        ("D", dt.timedelta(hours=6), False),
        ("M", dt.timedelta(hours=20), True),
        ("M", dt.timedelta(days=3), False),
        ("Q", dt.timedelta(days=2), True),
        ("Y", dt.timedelta(days=5), True),
        ("X", dt.timedelta(hours=20), True),  # unknown freq -> 1-day default
    ]:
        record = _sample().to_cache_record()
        record["freq"] = freq
        record["fetched_at"] = (now - age).isoformat()
        assert is_fresh(record, now=now) is expected, f"{freq} aged {age}"


def test_missing_or_unparseable_timestamp_is_stale() -> None:
    now = dt.datetime(2026, 9, 12, tzinfo=dt.timezone.utc)
    assert is_fresh(None, now=now) is False
    assert is_fresh({"freq": "M"}, now=now) is False
    assert is_fresh({"freq": "M", "fetched_at": "yesterday"}, now=now) is False


def test_naive_timestamp_is_treated_as_utc() -> None:
    """A stamp without an offset must not raise or compare against local time."""
    record = _sample().to_cache_record()
    record["fetched_at"] = "2026-09-12T11:00:00"
    assert is_fresh(record, now=dt.datetime(2026, 9, 12, 12, tzinfo=dt.timezone.utc)) is True


def test_slug_prefers_the_stable_index_id_over_the_label() -> None:
    """Labels get reworded; the indicator code does not."""
    assert slug_for(RETAIL_NAME, "M001657195") == "m001657195"
    assert slug_for("随便一个写法", "M001657195") == "m001657195"


def test_slug_without_an_index_id_stays_unique_across_shared_prefixes() -> None:
    """Two long labels differing only past the truncation point must not collide."""
    first = slug_for("全国:社会消费品零售总额:当月同比:修订版甲甲甲甲甲甲甲甲甲甲甲甲")
    second = slug_for("全国:社会消费品零售总额:当月同比:修订版乙乙乙乙乙乙乙乙乙乙乙乙")
    assert first != second
    assert "/" not in first and "\\" not in first


def test_two_series_with_the_same_index_id_share_one_cache_entry() -> None:
    """Re-fetching an indicator refreshes it instead of littering the store."""
    first = save_series(_sample())
    second = save_series(_sample())
    assert first == second
    assert len(list_cached()) == 1
