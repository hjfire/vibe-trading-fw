import { Activity, BarChart3, BellRing, BookOpen, Bot, CalendarClock, CandlestickChart, Database, FileText, Grid2x2, Layers, Settings, TrendingUp, WalletCards } from "lucide-react";

export const NAVIGATION_GROUPS = [
  { id: "research", items: [
    { id: "agent", to: "/", icon: Bot },
    { id: "reports", to: "/reports", icon: FileText },
    { id: "portfolio", to: "/portfolio", icon: WalletCards },
  ] },
  { id: "analysis", items: [
    { id: "alphaZoo", to: "/alpha-zoo", icon: Layers },
    { id: "optionsLab", to: "/options", icon: CandlestickChart },
    { id: "correlation", to: "/correlation", icon: BarChart3 },
    // Local custom ⑧/⑨: the two chart workbench pages. Their own slots are
    // deliberate -- a view reachable only by typing the URL is a view nobody
    // finds, which is the complaint that closed ⑨.
    { id: "proChart", to: "/pro-chart", icon: TrendingUp },
    { id: "multiChart", to: "/multi-chart", icon: Grid2x2 },
  ] },
  { id: "automation", items: [
    { id: "scheduled", to: "/scheduled", icon: CalendarClock },
    { id: "runtime", to: "/runtime", icon: Activity },
    // Local custom ㉑/㊱/㉔: alerting, the local bar warehouse, and the manual.
    { id: "alerts", to: "/alerts", icon: BellRing },
    { id: "warehouse", to: "/warehouse", icon: Database },
    { id: "settings", to: "/settings", icon: Settings },
    { id: "help", to: "/help", icon: BookOpen },
  ] },
] as const;

export type NavigationItem = typeof NAVIGATION_GROUPS[number]["items"][number];

export function isNavigationActive(to: string, pathname: string): boolean {
  return to === "/" ? pathname === "/" || pathname === "/agent"
    : pathname === to || pathname.startsWith(`${to}/`);
}
