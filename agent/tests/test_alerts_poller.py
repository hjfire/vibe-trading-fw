"""The background loop: the part of alerting that must not die quietly.

Everything beside the poller is synchronous and is tested against fixed inputs.
This file covers the one component that owns a task, where the failure modes
that matter live:

* a pass that raises must not take the loop down — a runtime that stops
  alerting without a word is the worst outcome this design can produce;
* ``start()`` runs from the API server's startup path, but the class is also
  constructed by plain scripts that never run a loop, so a missing loop has to
  be a log line rather than an exception;
* ``wake()`` is advisory — it makes a just-created rule prompt, never correct —
  so it must be safe from any thread and from a context with nothing to wake;
* the retry sweep has its own cadence, and a failed sweep must not end
  alerting either.

Nothing here sleeps for real: the loop is paced by ``_sleep``, which the tests
either replace or bound with a timeout, so a wake-up that never lands fails
fast instead of hanging CI.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable, List, Optional

import pytest

from src.alerts.poller import (
    DEFAULT_SWEEP_INTERVAL_MS,
    DEFAULT_TICK_INTERVAL_MS,
    AlertPoller,
)
from src.alerts.service import TickReport


class _FakeService:
    """A stand-in for :class:`~src.alerts.service.AlertService`.

    Records every pass so the test can count them, and can fail the first few
    ticks or sweeps on request — that is the whole reason this file exists.
    """

    def __init__(
        self,
        *,
        fail_ticks: int = 0,
        fail_sweeps: int = 0,
        report: Optional[TickReport] = None,
    ) -> None:
        self.now_seen: List[Optional[int]] = []
        self.sweeps = 0
        self.sweep_limits: List[int] = []
        self._fail_ticks = fail_ticks
        self._fail_sweeps = fail_sweeps
        self._report = report or TickReport(evaluated=1, fired=1, delivered=1)

    @property
    def passes(self) -> int:
        """How many ticks were attempted, successful or not."""
        return len(self.now_seen)

    async def tick(self, now_ms: Optional[int] = None) -> TickReport:
        self.now_seen.append(now_ms)
        if self._fail_ticks > 0:
            self._fail_ticks -= 1
            raise RuntimeError("data feed is unreachable")
        return self._report

    async def sweep_deliveries(self, limit: int = 20) -> int:
        self.sweeps += 1
        self.sweep_limits.append(limit)
        if self._fail_sweeps > 0:
            self._fail_sweeps -= 1
            raise RuntimeError("channel runtime is not running")
        return 0


def _pace(poller: AlertPoller, service: _FakeService, passes: int) -> None:
    """Give the loop no real sleep and stop it once *passes* passes are done."""

    async def _no_sleep() -> None:
        if service.passes >= passes:
            poller._stopping = True
        await asyncio.sleep(0)

    poller._sleep = _no_sleep  # type: ignore[method-assign]


# ---------------------------------------------------------------------------
# Start / stop
# ---------------------------------------------------------------------------


def test_a_disabled_poller_starts_nothing() -> None:
    """``enabled=False`` follows the scheduler switch; a started loop anyway
    would evaluate rules the operator turned off."""

    async def scenario() -> None:
        service = _FakeService()
        poller = AlertPoller(service, enabled=False)
        poller.start()
        assert poller.is_running is False
        await poller.stop()
        assert service.passes == 0

    asyncio.run(scenario())


def test_starting_without_an_event_loop_is_quiet() -> None:
    """A sync caller (a script importing the API server) must not be broken by a
    poller it will never await."""
    service = _FakeService()
    poller = AlertPoller(service)
    poller.start()
    assert poller.is_running is False
    assert service.passes == 0


def test_starting_twice_does_not_run_two_loops() -> None:
    """Two loops on one store would double every notification."""

    async def scenario() -> None:
        poller = AlertPoller(_FakeService())
        started: List[str] = []

        async def _fake_run() -> None:
            started.append("run")
            await asyncio.sleep(3600)

        poller._run = _fake_run  # type: ignore[method-assign]
        poller.start()
        first = poller._task
        poller.start()
        await asyncio.sleep(0)  # let the scheduled task actually begin

        assert poller._task is first
        assert started == ["run"]
        assert first is not None and first.get_name() == "alert-poller"
        await poller.stop()
        assert poller.is_running is False

    asyncio.run(scenario())


def test_stopping_is_idempotent_and_safe_before_a_start() -> None:
    async def scenario() -> None:
        service = _FakeService()
        poller = AlertPoller(service, enabled=False)
        await poller.stop()  # never started

        poller = AlertPoller(service, tick_interval_ms=1000)
        poller.start()
        await poller.stop()
        await poller.stop()
        assert poller.is_running is False

    asyncio.run(scenario())


def test_a_restarted_poller_measures_again() -> None:
    """A poller that ran once must be startable again: ``stop()`` arms the exit
    flag, and only ``start()`` clears it — so a restart goes through the public
    path, exactly as the API server's startup does."""

    async def scenario() -> None:
        service = _FakeService()
        poller = AlertPoller(service, tick_interval_ms=1000, sweep_interval_ms=1000)

        _pace(poller, service, 2)
        poller.start()
        await _await_passes(service, 2)
        await poller.stop()
        assert poller.is_running is False

        _pace(poller, service, 5)
        poller.start()
        await _await_passes(service, 5)
        await poller.stop()
        assert service.passes == 5

    asyncio.run(scenario())


async def _await_passes(service: _FakeService, count: int, timeout: float = 5.0) -> None:
    """Wait until the loop has attempted *count* passes."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while service.passes < count:
        assert loop.time() < deadline, "the poller loop stalled"
        await asyncio.sleep(0.001)


# ---------------------------------------------------------------------------
# Resilience
# ---------------------------------------------------------------------------


def test_a_failing_pass_is_logged_and_the_loop_carries_on(caplog: pytest.LogCaptureFixture) -> None:
    """The rule that could not be measured today must be measured tomorrow, and
    the operator has to be able to find out why it could not be measured today."""
    caplog.set_level(logging.WARNING)

    async def scenario() -> None:
        service = _FakeService(fail_ticks=1)
        poller = AlertPoller(service, tick_interval_ms=1000, sweep_interval_ms=1000)
        _pace(poller, service, 3)
        await asyncio.wait_for(poller._run(), timeout=5)
        assert service.passes == 3  # the raise did not end the loop

    asyncio.run(scenario())

    assert "pass failed" in caplog.text
    assert "data feed is unreachable" in caplog.text


def test_a_failing_sweep_does_not_end_alerting() -> None:
    """Retry transport and evaluate rules are separate worries: a channel that
    is down must not stop the next measurement."""

    async def scenario() -> None:
        service = _FakeService(fail_sweeps=1)
        poller = AlertPoller(service, tick_interval_ms=1000, sweep_interval_ms=1000)
        _pace(poller, service, 3)
        await asyncio.wait_for(poller._run(), timeout=5)
        assert (service.passes, service.sweeps) == (3, 3)

    asyncio.run(scenario())


def test_a_stop_requested_mid_pass_does_not_run_another() -> None:
    """Cancellation while the loop is inside a pass must be honoured before the
    next one, or ``stop()`` would race an unbounded tail of work."""

    async def scenario() -> None:
        service = _FakeService()
        poller = AlertPoller(service, tick_interval_ms=1000)
        poller._sleep = _stopping_after_first_pass(poller)
        await asyncio.wait_for(poller._run(), timeout=5)
        assert service.passes == 1

    asyncio.run(scenario())


def _stopping_after_first_pass(poller: AlertPoller) -> Callable[[], Any]:
    async def _sleep() -> None:
        poller._stopping = True

    return _sleep


# ---------------------------------------------------------------------------
# Cadence
# ---------------------------------------------------------------------------


def test_intervals_are_clamped_to_usable_values() -> None:
    """A 1 ms tick would hammer every data feed, and a sweep shorter than a tick
    would make the "every N passes" arithmetic below it divide by zero."""
    service = _FakeService()
    small = AlertPoller(service, tick_interval_ms=1, sweep_interval_ms=1)
    assert small.tick_interval_ms == 1000
    assert small.sweep_interval_ms == 1000

    inverted = AlertPoller(service, tick_interval_ms=10 * 60 * 1000)
    assert inverted.sweep_interval_ms == inverted.tick_interval_ms

    assert AlertPoller(service).tick_interval_ms == DEFAULT_TICK_INTERVAL_MS


def test_the_sweep_runs_on_its_own_cadence() -> None:
    async def scenario() -> None:
        service = _FakeService()
        poller = AlertPoller(service, tick_interval_ms=1000, sweep_interval_ms=3000)
        _pace(poller, service, 7)
        await asyncio.wait_for(poller._run(), timeout=5)
        assert service.passes == 7
        # Retrying an owed notification every minute buys nothing; every third
        # pass is what the 3 s/1 s ratio asks for (3 passes per sweep here).
        assert service.sweeps == 2
        assert service.sweep_limits == [20, 20]

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# wake()
# ---------------------------------------------------------------------------


def test_a_wake_from_another_thread_cuts_the_tick_short() -> None:
    """Route handlers may be served off the loop's own thread, so ``wake`` has
    to reach the poller's loop rather than look for a loop in the caller."""

    async def scenario() -> None:
        service = _FakeService()
        poller = AlertPoller(service, tick_interval_ms=DEFAULT_TICK_INTERVAL_MS)
        poller._wake = asyncio.Event()
        poller._loop = asyncio.get_running_loop()

        sleeping = asyncio.create_task(poller._sleep())
        await asyncio.sleep(0)  # let the sleep park on the event
        assert not sleeping.done()

        await asyncio.to_thread(poller.wake)
        await asyncio.wait_for(sleeping, timeout=5)
        assert poller._wake.is_set() is False  # the wake was consumed, not left armed

    asyncio.run(scenario())


def test_wake_before_start_is_a_no_op() -> None:
    poller = AlertPoller(_FakeService())
    poller.wake()
    assert poller._wake is None


def test_wake_after_stop_does_not_resurrect_a_dead_loop() -> None:
    async def scenario() -> None:
        service = _FakeService()
        poller = AlertPoller(service, tick_interval_ms=1000, sweep_interval_ms=1000)
        _pace(poller, service, 1)
        await asyncio.wait_for(poller._run(), timeout=5)
        await poller.stop()
        assert poller._loop is None
        poller.wake()  # must not raise on the stale event

    asyncio.run(scenario())


def test_sleep_without_an_event_is_a_plain_sleep() -> None:
    """The fallback matters for a loop driven without ``start()``."""

    async def scenario() -> None:
        poller = AlertPoller(_FakeService(), tick_interval_ms=1000)
        assert poller._wake is None
        await asyncio.wait_for(poller._sleep(), timeout=5)

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# run_once
# ---------------------------------------------------------------------------


def test_run_once_returns_the_report_as_a_dict() -> None:
    """``/alerts/run`` hands this straight to JSON, so it must not be a dataclass."""

    async def scenario() -> None:
        service = _FakeService()
        poller = AlertPoller(service, now_fn=lambda: 1_767_232_800_000)
        report = await poller.run_once()
        assert isinstance(report, dict)
        assert (report["evaluated"], report["fired"], report["delivered"]) == (1, 1, 1)
        assert service.now_seen == [1_767_232_800_000]

    asyncio.run(scenario())


def test_the_wall_clock_is_the_fallback() -> None:
    poller = AlertPoller(_FakeService())
    assert abs(poller._now_ms() - time.time() * 1000) < 60_000
