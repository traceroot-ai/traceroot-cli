import { describe, expect, it } from "vitest";
import { parseEnvFile } from "../src/config/envFile.js";

describe("parseEnvFile", () => {
  it("parses a simple KEY=VALUE line", () => {
    expect(parseEnvFile("FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("ignores blank lines and comment lines", () => {
    const content = "\n# a comment\nFOO=bar\n\n   # indented comment\nBAZ=qux\n";
    expect(parseEnvFile(content)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("trims whitespace around key and value", () => {
    expect(parseEnvFile("  FOO  =  bar  ")).toEqual({ FOO: "bar" });
  });

  it("strips surrounding double quotes from the value", () => {
    expect(parseEnvFile('FOO="bar baz"')).toEqual({ FOO: "bar baz" });
  });

  it("strips surrounding single quotes from the value", () => {
    expect(parseEnvFile("FOO='bar baz'")).toEqual({ FOO: "bar baz" });
  });

  it("keeps a # that appears inside an unquoted value", () => {
    expect(parseEnvFile("FOO=bar#baz")).toEqual({ FOO: "bar#baz" });
  });

  it("ignores lines without an = sign", () => {
    expect(parseEnvFile("FOO=bar\nNOEQUALS\nBAZ=qux")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("supports the export KEY=VALUE form", () => {
    expect(parseEnvFile("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("handles CRLF line endings", () => {
    expect(parseEnvFile("FOO=bar\r\nBAZ=qux\r\n")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("lets the last duplicate key win", () => {
    expect(parseEnvFile("FOO=first\nFOO=second")).toEqual({ FOO: "second" });
  });

  it("splits on the first = so the value may contain = (e.g. a URL with query)", () => {
    expect(parseEnvFile("URL=https://api.example/path?a=1&b=2")).toEqual({
      URL: "https://api.example/path?a=1&b=2",
    });
  });

  it("returns an empty map for empty input", () => {
    expect(parseEnvFile("")).toEqual({});
  });
});
