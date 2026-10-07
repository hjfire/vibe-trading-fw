import { describe, expect, it } from "vitest";

import {
  DEFAULT_REPLAY_BACK,
  REPLAY_MORE,
  cursorBar,
  cursorFromDatePick,
  cursorFromView,
  formatReplayDate,
  indexAtOrBefore,
  isFutureDrawing,
  isReplayExhausted,
  paceMs,
  replayReadout,
  replayWindow,
  stepCursor,
} from "../barReplay";

/** Ten daily bars, one per 86 400 000 ms starting at the unix epoch. */
const DAY = 86_400_000;
const bars = (n: number) => Array.from({ length: n }, (_, i) => ({ timestamp: i * DAY, close: i }));
const TEN = bars(10);

/** A cache whose neighbours share one instant — `shapeResponse` only trims *across* pages. */
const stamped = (...days: number[]) => days.map((d) => ({ timestamp: d * DAY }));
const DUP = stamped(0, 1, 2, 5, 5, 6, 7, 8); // indices 3 and 4 are both 5 * DAY
const NEWEST_DUP = stamped(0, 1, 2, 3, 9, 9); // the duplicated pair is the newest bar
const ALL_DUP = stamped(7, 7, 7, 7, 7); // every bar names the same instant
const LONG_DUP = stamped(1, ...Array.from({ length: 11 }, () => 2), 3, 4); // a run wider than 10
/** A five-wide run in the middle: anchoring on its first bar instead of its last moves the answer. */
const MID_DUP = stamped(0, 1, 2, 2, 2, 2, 2, 3, 4); // indices 2..6 are all 2 * DAY

describe("indexAtOrBefore", () => {
  it("命中精确的 bar 戳", () => {
    expect(indexAtOrBefore(TEN, 4 * DAY)).toBe(4);
  });
  it("落在两根之间取更早那根（回放里绝不许取未来）", () => {
    expect(indexAtOrBefore(TEN, 4 * DAY + 1)).toBe(4);
    expect(indexAtOrBefore(TEN, 5 * DAY - 1)).toBe(4);
  });
  it("早于首根返回 -1，晚于末根返回末根", () => {
    expect(indexAtOrBefore(TEN, -1)).toBe(-1);
    expect(indexAtOrBefore(TEN, 99 * DAY)).toBe(9);
  });
  it("空表返回 -1", () => {
    expect(indexAtOrBefore([], 0)).toBe(-1);
  });
});

describe("replayWindow", () => {
  it("cursor 为 null 时交回全量（退出回放）", () => {
    expect(replayWindow(TEN, null)).toEqual(TEN);
  });
  it("只含 ≤ cursor 的前缀，且含 cursor 那一根", () => {
    expect(replayWindow(TEN, 3 * DAY).map((b) => b.timestamp)).toEqual([0, DAY, 2 * DAY, 3 * DAY]);
  });
  it("cursor 早于首根时是空表，不是全表", () => {
    expect(replayWindow(TEN, -1)).toEqual([]);
  });
});

describe("stepCursor", () => {
  it("向右一根", () => {
    expect(stepCursor(TEN, 3 * DAY, 1)).toBe(4 * DAY);
  });
  it("向左 250 根不足时停在首根", () => {
    expect(stepCursor(TEN, 2 * DAY, -250)).toBe(0);
  });
  it("末根再向右停在末根，不越界", () => {
    expect(stepCursor(TEN, 9 * DAY, 1)).toBe(9 * DAY);
  });
  it("游标指向已被裁掉的戳（换周期后可能发生）时落回最近的一根", () => {
    expect(stepCursor(TEN, 4 * DAY + 1, 1)).toBe(5 * DAY);
  });
  it("空表原样返回，不抛", () => {
    expect(stepCursor([], 5 * DAY, 1)).toBe(5 * DAY);
  });
  it("游标早于首根：两个方向都钳在首根，与无重复表一致", () => {
    expect(stepCursor(TEN, -1, -1)).toBe(0);
    expect(stepCursor(TEN, -1, 1)).toBe(DAY);
  });
  it("同戳连档上向左一根：跨过重复真的动，不许把游标自己交回去", () => {
    expect(stepCursor(DUP, 5 * DAY, -1)).toBe(2 * DAY);
  });
  it("同戳连档上向右一根：还是下一根，不被跨重复带偏", () => {
    expect(stepCursor(DUP, 5 * DAY, 1)).toBe(6 * DAY);
  });
  it("末根重复：向右是死点击（原样返回），向左照样跨出去", () => {
    expect(stepCursor(NEWEST_DUP, 9 * DAY, 1)).toBe(9 * DAY);
    expect(stepCursor(NEWEST_DUP, 9 * DAY, -1)).toBe(3 * DAY);
  });
  it("全表同戳：前后都无处可去，原样返回游标", () => {
    expect(stepCursor(ALL_DUP, 7 * DAY, -1)).toBe(7 * DAY);
    expect(stepCursor(ALL_DUP, 7 * DAY, 1)).toBe(7 * DAY);
    expect(stepCursor(ALL_DUP, 7 * DAY, -250)).toBe(7 * DAY);
  });
  it("快退 10 根落在同戳连档里：跨出连档才算真的退了", () => {
    expect(stepCursor(LONG_DUP, 2 * DAY, -10)).toBe(DAY);
    expect(stepCursor(LONG_DUP, 2 * DAY, 1)).toBe(3 * DAY);
  });
  it("步进与窗口同锚点：连档按最后一个同戳根算，两个方向都是", () => {
    expect(replayWindow(MID_DUP, 2 * DAY).length).toBe(7); // through index 6, the run's last bar
    expect(stepCursor(MID_DUP, 2 * DAY, -2)).toBe(1 * DAY);
    expect(stepCursor(MID_DUP, 2 * DAY, 2)).toBe(4 * DAY);
  });
});

describe("isReplayExhausted", () => {
  it("末根为真，其余为假，空表为假", () => {
    expect(isReplayExhausted(TEN, 9 * DAY)).toBe(true);
    expect(isReplayExhausted(TEN, 8 * DAY)).toBe(false);
    expect(isReplayExhausted([], 0)).toBe(false);
  });
});

describe("cursorFromView", () => {
  it("下标钳进表内（库可能给出越界值）", () => {
    expect(cursorFromView(TEN, 3)).toBe(3 * DAY);
    expect(cursorFromView(TEN, 99)).toBe(9 * DAY);
    expect(cursorFromView(TEN, -5)).toBe(0);
  });
  it("空表返回 null", () => {
    expect(cursorFromView([], 0)).toBeNull();
  });
});

describe("isFutureDrawing", () => {
  it("任一锚点在游标之后即为未来画线", () => {
    expect(isFutureDrawing([{ timestamp: DAY }, { timestamp: 5 * DAY }], 3 * DAY)).toBe(true);
    expect(isFutureDrawing([{ timestamp: DAY }, { timestamp: 3 * DAY }], 3 * DAY)).toBe(false);
  });
  it("裸 dataIndex 锚点没有位置意义上的时间，不算未来", () => {
    expect(isFutureDrawing([{ value: 12 }], 3 * DAY)).toBe(false);
  });
  it("容忍 null/undefined 锚点（半途落点的线）", () => {
    expect(isFutureDrawing([null, undefined, { timestamp: 9 * DAY }], 3 * DAY)).toBe(true);
  });
});

describe("paceMs / REPLAY_MORE / cursorBar", () => {
  it("四档倍速单调不增，1× 是一秒一根", () => {
    expect(paceMs("1")).toBe(1000);
    expect(paceMs("0.5")).toBeGreaterThan(paceMs("1"));
    expect(paceMs("4")).toBeLessThan(paceMs("1"));
  });
  it("两旗都钉死 —— 这是回放的未来数据硬闸", () => {
    expect(REPLAY_MORE).toEqual({ forward: false, backward: false });
  });
  it("cursorBar 返回游标所在那根，游标早于首根时 null", () => {
    expect(cursorBar(TEN, 2 * DAY)?.timestamp).toBe(2 * DAY);
    expect(cursorBar(TEN, -1)).toBeNull();
  });
});

describe("replayReadout", () => {
  it("读数含第几根/共几根/剩余根数，游标不在表内时按落位的那根计", () => {
    expect(replayReadout(TEN, 4 * DAY)).toEqual({ shown: 5, total: 10, remaining: 5, index: 4 });
    expect(replayReadout(TEN, 4 * DAY + 1)).toEqual({ shown: 5, total: 10, remaining: 5, index: 4 });
  });
  it("空表读数全 0，不出现 NaN 或 -1", () => {
    expect(replayReadout([], 0)).toEqual({ shown: 0, total: 0, remaining: 0, index: -1 });
  });
  it("DEFAULT_REPLAY_BACK 是 250（日线约一年）", () => {
    expect(DEFAULT_REPLAY_BACK).toBe(250);
  });
});

describe("formatReplayDate / cursorFromDatePick", () => {
  // Daily bars stamped at the exchange's 15:00 CST, i.e. 07:00 UTC.
  const daily = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ timestamp: Date.UTC(2020, 0, 1 + i) + 7 * 3_600_000 }));

  it("15:00 CST 的日线 bar 挑同日不落到前一天", () => {
    const bars = daily(5);
    expect(cursorFromDatePick(bars, "1970-01-01")).toBeNull();
    expect(cursorFromDatePick(bars, "2020-01-01")).toBe(bars[0].timestamp);
    expect(cursorFromDatePick(bars, "2020-01-03")).toBe(bars[2].timestamp);
    expect(cursorFromDatePick(bars, "2030-01-01")).toBe(bars[4].timestamp);
  });

  it("非法串返回 null，不抛", () => {
    const bars = daily(3);
    expect(cursorFromDatePick(bars, "2020-1-1")).toBeNull();
    expect(cursorFromDatePick(bars, "not-a-date")).toBeNull();
  });

  it("读数与日期框互为反函数：显示的那天输回去必须落回同一根", () => {
    const bars = daily(6);
    for (const b of bars) {
      expect(cursorFromDatePick(bars, formatReplayDate(b.timestamp))).toBe(b.timestamp);
    }
  });
});
