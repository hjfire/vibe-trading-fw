import "i18next";
import type en from "./i18n/locales/en.json";
import type forkEn from "./i18n/fork/en.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: typeof en & typeof forkEn;
    };
  }
}
