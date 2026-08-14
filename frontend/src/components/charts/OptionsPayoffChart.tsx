import { useEffect, useRef } from "react";
import i18n from "@/i18n";
import type { ExpiryCurve } from "@/lib/options";
import { getChartTheme } from "@/lib/chart-theme";
import { getPnlColors } from "@/lib/pnl-colors";
import { abbreviateNum } from "@/lib/formatters";
import { echarts, CHART_GROUP, connectCharts } from "@/lib/echarts";
import { useThemeDark } from "@/lib/theme-store";

interface Props {
  curve: ExpiryCurve;
  entrySpot: number;
  breakevens: number[];
  height?: number;
}

export function OptionsPayoffChart({ curve, entrySpot, breakevens, height = 340 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const dark = useThemeDark();

  useEffect(() => {
    if (!ref.current || curve.spot.length === 0 || curve.pnl.length === 0) return;
    const t = getChartTheme();
    const pnlC = getPnlColors();
    const chart = echarts.init(ref.current);
    chart.group = CHART_GROUP;
    connectCharts();

    const pnlLabel = i18n.t("options.payoff.pnl");
    const spotLabel = i18n.t("options.payoff.entrySpot");
    const beLabel = i18n.t("options.payoff.breakeven");

    const pairs: [number, number][] = curve.spot.map((s, idx) => [s, curve.pnl[idx] ?? 0]);
    const profitData = pairs.map(([s, v]) => [s, v >= 0 ? v : null]);
    const lossData = pairs.map(([s, v]) => [s, v <= 0 ? v : null]);

    chart.setOption({
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        backgroundColor: t.tooltipBg,
        borderColor: t.tooltipBorder,
        textStyle: { color: t.tooltipText, fontSize: 11 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        formatter: (params: any) => {
          if (!Array.isArray(params) || !params.length) return "";
          const main = params.find((p) => p.seriesName === pnlLabel) ?? params[0];
          const [spotVal, pnlVal] = Array.isArray(main.value) ? main.value : [main.axisValue, NaN];
          const pnlNum = Number(pnlVal);
          const pnlText = Number.isFinite(pnlNum)
            ? pnlNum.toLocaleString(undefined, { maximumFractionDigits: 2 })
            : "–";
          return `<b>${Number(spotVal).toLocaleString()}</b><br/>${main.marker} ${pnlLabel}: <b>${pnlText}</b>`;
        },
      },
      legend: {
        data: [pnlLabel],
        textStyle: { color: t.textColor, fontSize: 11 },
        right: 60,
        top: 4,
      },
      toolbox: {
        feature: {
          saveAsImage: { title: "Save" },
          restore: { title: "Reset" },
        },
        right: 8,
        top: 0,
        iconStyle: { borderColor: t.textColor },
      },
      grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
      xAxis: {
        type: "value",
        name: i18n.t("options.payoff.spot"),
        nameTextStyle: { color: t.textColor, fontSize: 10 },
        nameLocation: "middle",
        nameGap: 26,
        axisLine: { lineStyle: { color: t.axisColor } },
        axisLabel: {
          color: t.textColor,
          fontSize: 10,
          formatter: (v: number) => v.toLocaleString(),
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: t.gridColor } },
        axisLabel: { color: t.textColor, fontSize: 10, formatter: (v: number) => abbreviateNum(v) },
      },
      series: [
        {
          name: pnlLabel,
          type: "line",
          data: pairs,
          smooth: false,
          symbol: "none",
          lineStyle: { color: t.infoColor, width: 2 },
          markLine: {
            silent: true,
            symbol: "none",
            data: [
              {
                yAxis: 0,
                lineStyle: { color: t.axisColor, type: "solid", width: 1 },
                label: { show: false },
              },
              {
                xAxis: entrySpot,
                lineStyle: { color: t.textColor, type: "dashed", width: 1 },
                label: {
                  formatter: spotLabel,
                  position: "end",
                  fontSize: 10,
                  color: t.textColor,
                },
              },
              ...breakevens.map((be) => ({
                xAxis: be,
                lineStyle: { color: t.warningColor, type: "dashed", width: 1 },
                label: {
                  formatter: `${beLabel} ${be.toLocaleString()}`,
                  position: "middle" as const,
                  fontSize: 10,
                  color: t.warningColor,
                },
              })),
            ],
          },
        },
        {
          name: "profit-fill",
          type: "line",
          data: profitData,
          silent: true,
          symbol: "none",
          lineStyle: { width: 0 },
          areaStyle: { origin: 0, color: pnlC.profit + "30" },
          tooltip: { show: false },
        },
        {
          name: "loss-fill",
          type: "line",
          data: lossData,
          silent: true,
          symbol: "none",
          lineStyle: { width: 0 },
          areaStyle: { origin: 0, color: pnlC.loss + "30" },
          tooltip: { show: false },
        },
      ],
    });

    let resizeFrame: number | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        chart.resize();
      });
    });
    ro.observe(ref.current!);
    return () => {
      ro.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      chart.dispose();
    };
  }, [curve, entrySpot, breakevens, dark]);

  if (curve.spot.length === 0 || curve.pnl.length === 0) {
    return <div className="text-muted-foreground text-sm p-4">{i18n.t("options.payoff.noData")}</div>;
  }
  return <div ref={ref} style={{ height }} />;
}
