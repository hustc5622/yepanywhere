import { describe, expect, it } from "vitest";
import { SUPPORTED_LOCALES } from "./i18n";
import enMessages from "./i18n/en.json";
import zhCnMessages from "./i18n/zh-CN.json";

const localeModules = import.meta.glob("./i18n/*.json");

describe("i18n support policy", () => {
  it("supports only English and Simplified Chinese", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "zh-CN"]);
    expect(Object.keys(localeModules).sort()).toEqual([
      "./i18n/en.json",
      "./i18n/zh-CN.json",
    ]);
  });

  it("keeps the English and Simplified Chinese message keys in sync", () => {
    expect(Object.keys(zhCnMessages).sort()).toEqual(
      Object.keys(enMessages).sort(),
    );
  });
});
