import { describe, expect, it } from "vitest";
import { headingMenu } from "./model";

describe("native heading menu", () => {
  it("keeps heading actions and selected values in the Win32 popup", () => {
    const menu = headingMenu({ style: "title", align: "center", underline: true });
    expect(menu.map((item) => item.sep ? "-" : item.id)).toEqual([
      "heading:edit", "heading:align", "heading:style", "heading:underline", "-", "heading:delete",
    ]);
    expect(menu[1].items?.map((item) => [item.id, item.checked])).toEqual([
      ["heading:align:left", false], ["heading:align:center", true],
    ]);
    expect(menu[2].items?.filter((item) => item.checked).map((item) => item.id)).toEqual(["heading:style:title"]);
    expect(menu.find((item) => item.id === "heading:underline")?.checked).toBe(true);
  });

  it("omits underline for dividers and checks the divider style", () => {
    const menu = headingMenu({ style: "divider", align: "left" });
    expect(menu.some((item) => item.id === "heading:underline")).toBe(false);
    expect(menu[2].items?.filter((item) => item.checked).map((item) => item.id)).toEqual(["heading:style:divider"]);
  });
});
