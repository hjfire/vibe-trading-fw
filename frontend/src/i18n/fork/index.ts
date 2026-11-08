import type { SupportedLanguageCode } from "../index";
import forkEn from "./en.json";

type ForkLazyCode = Exclude<SupportedLanguageCode, "en">;

export { forkEn };

// Kept outside locales/ so upstream edits to those files never collide with
// ours. `satisfies` fails both ways: a registered language with no overlay, and
// an overlay for a language nobody registered.
export const forkLoaders = {
  "zh-CN": () => import("./zh-CN.json"),
  ja: () => import("./ja.json"),
  ko: () => import("./ko.json"),
  ar: () => import("./ar.json"),
  fa: () => import("./fa.json"),
  es: () => import("./es.json"),
  de: () => import("./de.json"),
  "pt-BR": () => import("./pt-BR.json"),
  id: () => import("./id.json"),
  tr: () => import("./tr.json"),
} satisfies Record<ForkLazyCode, () => Promise<{ default: typeof forkEn }>>;
