import { describe, expect, it } from "vitest";
import { extensionFor, formatBytes } from "../src/download.js";

describe("extensionFor", () => {
  it("reads the extension from a plain URL", () => {
    expect(extensionFor("https://cdn.test/a/b/clip.mp4", ".bin")).toBe(".mp4");
  });

  it("ignores the query string on a signed URL", () => {
    expect(extensionFor("https://cdn.test/clip.webm?sig=abc&exp=123", ".mp4")).toBe(".webm");
  });

  it("falls back when the path has no extension", () => {
    expect(extensionFor("https://cdn.test/generated/98a7f", ".glb")).toBe(".glb");
  });

  it("falls back on an unparseable URL", () => {
    expect(extensionFor("not a url", ".mp3")).toBe(".mp3");
  });

  it("rejects an implausibly long extension", () => {
    expect(extensionFor("https://cdn.test/file.superlongext", ".mp4")).toBe(".mp4");
  });
});

describe("formatBytes", () => {
  it("scales through B, KB and MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
