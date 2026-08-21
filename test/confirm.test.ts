import { describe, expect, it, afterEach } from "vitest";
import { confirm } from "../src/confirm.js";

const realTTY = process.stdin.isTTY;
afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", { value: realTTY, configurable: true });
});

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

describe("confirm", () => {
  it("passes straight through with --yes", async () => {
    setTTY(false);
    await expect(confirm("Delete everything?", { yes: true })).resolves.toBeUndefined();
  });

  // The rule that makes this a gate rather than decoration: a piped
  // `curvet apps delete` must stop, not destroy an app because nobody answered.
  it("refuses rather than assuming yes when there is no terminal", async () => {
    setTTY(false);
    await expect(confirm("Delete everything?")).rejects.toThrow(
      /Refusing to assume an answer/,
    );
  });

  it("names --yes in the refusal, since that is the fix for CI", async () => {
    setTTY(false);
    await expect(confirm("Rotate?")).rejects.toThrow(/--yes/);
  });
});
