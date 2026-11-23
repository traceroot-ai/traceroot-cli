import { describe, expect, it } from "vitest";
import { fieldLines } from "../../src/render/fields.js";
import { createStyler } from "../../src/render/style.js";
import { withoutForcedColor } from "../helpers/plainColor.js";
import { StringSink } from "../helpers/stringSink.js";

withoutForcedColor();

describe("fieldLines", () => {
  it("ends each label with a colon and starts every value two spaces after the longest label", () => {
    const styler = createStyler(new StringSink());
    expect(
      fieldLines(
        [
          ["Name", "a"],
          ["Dataset ID", "ds_1"],
        ],
        styler,
      ),
    ).toEqual(["Name:        a", "Dataset ID:  ds_1"]);
  });
});
