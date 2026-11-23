import { describe, expect, it } from "vitest";
import { fitTable, renderTable } from "../../src/render/table.js";

describe("renderTable", () => {
  it("includes the header row", () => {
    const out = renderTable(["A", "B"], [["1", "2"]]);
    const lines = out.split("\n");
    expect(lines[0]).toContain("A");
    expect(lines[0]).toContain("B");
  });

  it("aligns columns so each column starts at the same offset", () => {
    const out = renderTable(
      ["NAME", "ID"],
      [
        ["short", "1"],
        ["a-much-longer-value", "2"],
      ],
    );
    const lines = out.split("\n");
    // The second column ("ID" header and the id values) must start at the same
    // index on every line because the first column is padded to its max width.
    const idHeaderIdx = (lines[0] as string).indexOf("ID");
    const row1IdIdx = (lines[1] as string).indexOf("1");
    const row2IdIdx = (lines[2] as string).indexOf("2");
    expect(row1IdIdx).toBe(idHeaderIdx);
    expect(row2IdIdx).toBe(idHeaderIdx);
  });

  it("handles empty rows by rendering only the header", () => {
    const out = renderTable(["A", "B"], []);
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("A");
    expect(lines[0]).toContain("B");
  });

  it("widens a column to fit a long value while keeping later columns aligned", () => {
    const out = renderTable(
      ["X", "Y"],
      [
        ["tiny", "end"],
        ["this-is-a-very-very-long-value", "tail"],
      ],
    );
    const lines = out.split("\n");
    const headerYIdx = (lines[0] as string).indexOf("Y");
    expect((lines[1] as string).indexOf("end")).toBe(headerYIdx);
    expect((lines[2] as string).indexOf("tail")).toBe(headerYIdx);
  });

  it("does not emit ANSI color codes", () => {
    const out = renderTable(["A"], [["1"]]);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: testing for ESC
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("fitTable", () => {
  const headers = ["SCORE", "MEAN", "SCORED"];
  const rows = [
    ["exact_match", "0.667", "3 of 4"],
    ["正确性", "1", "4 of 4"],
  ];

  it("prints as renderTable does when it fits, lined up on display width", () => {
    expect(fitTable(headers, rows, { width: 80, indent: "  " })).toEqual([
      "  SCORE        MEAN   SCORED",
      "  exact_match  0.667  3 of 4",
      "  正确性       1      4 of 4",
    ]);
    expect(fitTable(headers, rows, { width: undefined })).toEqual(
      fitTable(headers, rows, { width: 80 }),
    );
  });

  it("stacks rows that don't fit, labelling each value with its header", () => {
    expect(fitTable(headers, rows, { width: 20, indent: "  " })).toEqual([
      "  exact_match",
      "    mean 0.667",
      "      scored 3 of 4",
      "  正确性",
      "    mean 1",
      "      scored 4 of 4",
    ]);
  });

  it("wraps only the last column when it is prose and the other columns fit", () => {
    expect(
      fitTable(["CASE", "ERROR"], [["case-1", "ValueError: cannot convert the value delta"]], {
        width: 32,
        wrapLast: true,
      }),
    ).toEqual(["CASE    ERROR", "case-1  ValueError: cannot", "        convert the value delta"]);
  });

  it("stacks instead when wrapping would leave the last column too narrow, unlabelled if asked", () => {
    expect(
      fitTable(["CASE", "ERROR"], [["tc_d2682fce6e8c00532e62", "KeyError: 'rubric'"]], {
        width: 30,
        wrapLast: true,
        labels: [false, false],
      }),
    ).toEqual(["tc_d2682fce6e8c00532e62", "  KeyError: 'rubric'"]);
  });
});
