import { describe, expect, it } from "vitest";
import { maskKey, table } from "../src/output.js";
import { v1Root } from "../src/client.js";
import { DEFAULT_BASE_URL } from "@curvet/sdk";

describe("maskKey", () => {
  it("keeps a recognizable prefix and suffix", () => {
    expect(maskKey("app_1234567890abcdef1234")).toBe("app_123456…1234");
  });
  it("collapses short keys entirely", () => {
    expect(maskKey("app_123")).toBe("app_…");
  });
});

describe("table", () => {
  it("pads columns to the widest cell", () => {
    const out = table(
      ["ID", "TYPE"],
      [
        ["gpt-4o", "chat"],
        ["wan-2.2", "video"],
      ],
    );
    const lines = out.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("gpt-4o");
    expect(lines[3]).toContain("wan-2.2");
  });
});

describe("v1Root", () => {
  it("strips the /playground suffix from the default base", () => {
    expect(v1Root(DEFAULT_BASE_URL)).toBe("https://curvet.ai/api/v1");
    expect(v1Root(undefined)).toBe("https://curvet.ai/api/v1");
  });
  it("handles a trailing slash", () => {
    expect(v1Root("https://x.test/api/v1/playground/")).toBe("https://x.test/api/v1");
  });
  it("leaves non-playground bases untouched", () => {
    expect(v1Root("https://x.test/api/v1")).toBe("https://x.test/api/v1");
  });
});
