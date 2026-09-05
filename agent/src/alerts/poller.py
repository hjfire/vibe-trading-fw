"""The background poller that keeps alert rules live.

Mirrors :class:`src.scheduled_research.executor.ScheduledResearchExecutor`:
one asyncio task, a fixed tick, a graceful stop, and — because alerting is
useless if it dies quietly — a pass that raises is logged and the loop carries
on. A rule that cannot be measured today must not turn into a runtime with no
alerting and no warning.

Enablement reuses the scheduler switch that already exists
(``VIBE_TRADING_ENABLE_SCHEDULER``, read through the config layer). Alerting is
part of "the background scheduler is running"; inventing a second flag would
give operators two things to disagree about.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from src.alerts.service import AlertService

logger = logging.getLogger(__name__)

#: How often rules are measured. Rule-level ``poll_interval_ms`` decides which
#: rules are due inside each tick, so this only bounds latency.
DEFAULT_TICK_INTERVAL_MS = 60 * 1000

#: How often owed-but-undelivered notifications are retried.
DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000


class AlertPoller:
    """Background loop driving :meth:`src.alerts.service.AlertService.tick`.

    Attributes:
        service: The alert service being driven.
        tick_interval_ms: Gap between passes.
    """

    def __init__(
        self,
        service: Optional[AlertService] = None,
        *,
        tick_interval_ms: int = DEFAULT_TICK_INTERVAL_MS,
        sweep_interval_ms: int = DEFAULT_SWEEP_INTERVAL_MS,
        enabled: bool = True,
        now_fn=None,  # type: ignore[no-untyped-def]
    ) -> None:
        """Initialize the poller.

        Args:
            service: Service to drive. Defaults to one on the shared store.
            tick_interval_ms: Sleep between passes.
            sweep_interval_ms: Sleep between delivery retries.
            enabled: When ``False``, :meth:`start` is a no-op.
            now_fn: Clock injection for tests (epoch milliseconds).
        """
        self.service = service if service is not None else AlertService()
        self.tick_interval_ms = max(1000, int(tick_interval_ms))
        self.sweep_interval_ms = max(self.tick_interval_ms, int(sweep_interval_ms))
        self._enabled = enabled
        self._now_fn = now_fn
        self._task: Optional[asyncio.Task] = None
        self._stopping = False
        self._wake: Optional[asyncio.Event] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    @property
    def is_running(self) -> bool:
        """Whether the background task is alive."""
        return self._task is not None and not self._task.done()

    def start(self) -> None:
        """Start the loop.

        Idempotent, and a no-op when disabled or when no event loop is running
        yet — the API server's startup path is async, so a missing loop means a
        caller (a plain script) that will never await the poller anyway. Failing
        loudly there would break that caller for no benefit.
        """
        if not self._enabled or self.is_running:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.info("no event loop running; alert poller not started")
            return
        self._stopping = False
        self._wake = asyncio.Event()
        self._task = loop.create_task(self._run(), name="alert-poller")

    async def stop(self) -> None:
        """Stop the loop and await it. Idempotent."""
        self._stopping = True
        if self._wake is not None:
            self._wake.set()
        task = self._task
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 - shutdown
                pass
        self._task = None
        self._loop = None

    def wake(self) -> None:
        """Ask the loop to run a pass soon (a rule was just created or edited).

        Non-blocking and safe to call from any context: the routes use it so a
        freshly created rule does not wait a full tick to be measured. The loop
        is the one captured by :meth:`_run`, not the caller's, so a wake-up
        requested from a worker thread still lands on the poller's loop. With no
        loop to wake this is a no-op: the periodic tick is what makes alerting
        correct, and this only makes it prompt.
        """
        wake, loop = self._wake, self._loop
        if wake is None or loop is None:
            return
        try:
            loop.call_soon_threadsafe(wake.set)
        except RuntimeError:  # pragma: no cover — loop closed mid-call
            pass

    async def _run(self) -> None:
        """The tick loop."""
        # Captured here rather than in ``start``: a caller may drive ``_run``
        # directly, and a wake-up needs a loop that is actually running.
        self._loop = asyncio.get_running_loop()
        last_sweep = 0
        while not self._stopping:
            try:
                await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — one bad pass must not end alerting
                logger.exception("alert poller pass failed; continuing")
            sweep_gap = self.sweep_interval_ms // max(1, self.tick_interval_ms)
            last_sweep += 1
            if last_sweep >= sweep_gap:
                last_sweep = 0
                try:
                    await self.service.sweep_deliveries()
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001
                    logger.exception("alert delivery sweep failed; continuing")
            if self._stopping:
                return
            await self._sleep()

    async def _sleep(self) -> None:
        """Sleep one tick, or wake early when :meth:`wake` fires."""
        if self._wake is None:
            await asyncio.sleep(self.tick_interval_ms / 1000.0)
            return
        try:
            await asyncio.wait_for(self._wake.wait(), timeout=self.tick_interval_ms / 1000.0)
        except asyncio.TimeoutError:
            pass
        self._wake.clear()

    async def run_once(self) -> dict:
        """Run a single evaluation pass.

        Returns:
            The pass's :class:`~src.alerts.service.TickReport` as a dict.
        """
        report = await self.service.tick(now_ms=self._now_ms())
        return report.as_dict()

    def _now_ms(self) -> int:
        """Epoch milliseconds, from the injected clock when there is one."""
        if self._now_fn is not None:
            return int(self._now_fn())
        import time

        return int(time.time() * 1000)
