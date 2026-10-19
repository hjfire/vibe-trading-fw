import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PANEL_VISIBILITY,
  PANELS_KEY,
  type PanelVisibility,
  loadPanelVisibility,
  normalizePanelVisibility,
  savePanelVisibility,
} from "../chartPanels";

/**
 * Panel visibility (L3 第①片). The spec boundary travels with this file:
 * `forensics/spec/drawings.md` TV-DW-05 only proves the counterpart's
 * visibility key name sits in its `session_storage_keys` line — the behaviour
 * (survives a reload, dies with the tab) is ours. So what is being guarded here
 * is *our* rule: one session key, deviation-only encoding, strict `=== true`.
 */

const ALL: PanelVisibility = {
  workbench: false,
  subIndicator: false,
  drawings: false,
  legend: false,
};

beforeEach(() => {
  sessionStorage.clear();
});

describe("loadPanelVisibility", () => {
  it("①键不存在 ⇒ 四枚全 false，且不等于引用同一个对象", () => {
    const a = loadPanelVisibility();
    expect(a).toEqual(ALL);
    a.drawings = true;
    expect(loadPanelVisibility().drawings).toBe(false);
  });

  it("②写一枚为真再读回 ⇒ 只有那枚真，盘上 JSON 只含该键", () => {
    savePanelVisibility({ ...ALL, drawings: true });
    expect(sessionStorage.getItem(PANELS_KEY)).toBe('{"drawings":true}');
    expect(loadPanelVisibility()).toEqual({ ...ALL, drawings: true });
  });

  it("③坏 JSON／缺键／非 true 的值一律回落默认", () => {
    sessionStorage.setItem(PANELS_KEY, "{not json");
    expect(loadPanelVisibility()).toEqual(ALL);
    sessionStorage.setItem(PANELS_KEY, '{"legend":true}');
    expect(loadPanelVisibility()).toEqual({ ...ALL, legend: true });
    for (const junk of ['{"drawings":"true"}', '{"drawings":1}', '{"drawings":{}}', '{"drawings":null}', "[]", "3"]) {
      sessionStorage.setItem(PANELS_KEY, junk);
      expect(loadPanelVisibility().drawings).toBe(false);
    }
  });

  it("④先让键存在，再写回全 false ⇒ 键被删掉", () => {
    savePanelVisibility({ ...ALL, drawings: true });
    expect(sessionStorage.getItem(PANELS_KEY)).not.toBeNull();
    savePanelVisibility(ALL);
    expect(sessionStorage.getItem(PANELS_KEY)).toBeNull();
  });

  it("⑤存储抛异常 ⇒ load 回落默认、save 不抛", () => {
    const real = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    const boom = (): Storage => {
      throw new Error("storage disabled");
    };
    Object.defineProperty(window, "sessionStorage", { configurable: true, get: boom });
    try {
      expect(loadPanelVisibility()).toEqual(ALL);
      expect(() => savePanelVisibility({ ...ALL, legend: true })).not.toThrow();
    } finally {
      if (real) Object.defineProperty(window, "sessionStorage", real);
    }
    // 还原必须真的还原：这根针在「getter 仍然中毒」的世界里红（写入被 save 吞掉 ⇒ 读回 null）
    savePanelVisibility({ ...ALL, legend: true });
    expect(sessionStorage.getItem(PANELS_KEY)).toBe('{"legend":true}');
    expect(loadPanelVisibility()).toEqual({ ...ALL, legend: true });
  });
});

describe("normalizePanelVisibility", () => {
  it("只认四枚已知键、只认真布尔", () => {
    expect(normalizePanelVisibility({ drawings: true, unknownKey: true })).toEqual({
      ...ALL,
      drawings: true,
    });
    expect(normalizePanelVisibility(null)).toEqual(DEFAULT_PANEL_VISIBILITY);
    expect(normalizePanelVisibility([true])).toEqual(ALL);
  });
});
