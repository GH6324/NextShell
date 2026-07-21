import { expect, test } from "vitest";
import { MANAGER_TABS } from "./constants";
import settingsConstantsSource from "../settings-center/constants.ts?raw";
import settingsTypesSource from "../settings-center/types.ts?raw";

test("connection manager exposes the expected tabs in order", () => {
  expect(MANAGER_TABS.map((tab) => tab.key)).toEqual([
    "connections",
    "keys",
    "proxies",
    "cloudSync",
    "recycleBin",
    "import"
  ]);

  const recycleBinTab = MANAGER_TABS.find((tab) => tab.key === "recycleBin");
  expect(recycleBinTab).toMatchObject({
    label: "回收站"
  });
});

test("settings center source no longer includes recycle bin section", () => {
  expect(settingsConstantsSource.includes('"recycleBin"')).toBe(false);
  expect(settingsTypesSource.includes('| "recycleBin"')).toBe(false);
});
