import { describe, expect, it } from "vitest";
import { renderCsv } from "../../src/render/csv.js";

describe("renderCsv", () => {
  it("renders header + simple rows with trailing newline", () => {
    const out = renderCsv(
      ["name", "age"],
      [
        ["Alice", "30"],
        ["Bob", "25"],
      ],
    );
    expect(out).toBe("name,age\nAlice,30\nBob,25\n");
  });

  it("quotes a cell that contains a comma", () => {
    const out = renderCsv(["city"], [["Portland, OR"]]);
    expect(out).toBe('city\n"Portland, OR"\n');
  });

  it("quotes a cell with a double quote and doubles the inner quote", () => {
    const out = renderCsv(["quote"], [['he said "hi"']]);
    expect(out).toBe('quote\n"he said ""hi"""\n');
  });

  it("quotes a cell that contains a newline", () => {
    const out = renderCsv(["notes"], [["line1\nline2"]]);
    expect(out).toBe('notes\n"line1\nline2"\n');
  });

  it("quotes a cell that contains a carriage return", () => {
    const out = renderCsv(["notes"], [["line1\rline2"]]);
    expect(out).toBe('notes\n"line1\rline2"\n');
  });

  it("serializes null and undefined cells as empty strings", () => {
    const out = renderCsv(["a", "b", "c"], [[null, undefined, "ok"]]);
    expect(out).toBe("a,b,c\n,,ok\n");
  });

  it("serializes an object cell via JSON.stringify and quotes when JSON has commas", () => {
    const out = renderCsv(["obj"], [[{ x: 1, y: 2 }]]);
    // JSON.stringify({x:1,y:2}) = '{"x":1,"y":2}' which contains a comma
    expect(out).toBe('obj\n"{""x"":1,""y"":2}"\n');
  });

  it("serializes number and boolean cells without quoting", () => {
    const out = renderCsv(["n", "b"], [[42, true]]);
    expect(out).toBe("n,b\n42,true\n");
  });

  it("emits only the header line when rows is empty", () => {
    const out = renderCsv(["col1", "col2"], []);
    expect(out).toBe("col1,col2\n");
  });
});
