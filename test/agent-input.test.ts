import { describe, expect, it } from "vitest";
import { readChunk } from "../src/agent/tui/App.js";

/**
 * Reading a chunk of terminal input.
 *
 * Extracted from the component precisely because the space bar broke and nothing
 * caught it: the handler trimmed what it appended, so a lone " " became an empty
 * string and was dropped. You could type, but never put a gap between two words —
 * and there was nothing on screen to explain why.
 */

describe("readChunk", () => {
  it("keeps a lone space, because a space is a keystroke", () => {
    expect(readChunk(" ")).toEqual({ text: " ", submit: false });
  });

  it("keeps spaces inside and at the end of what is typed", () => {
    // Typing "the " then "port" has to produce "the port", not "theport".
    expect(readChunk("the ").text).toBe("the ");
    expect(readChunk("a b c").text).toBe("a b c");
  });

  it("submits on a trailing newline, carrying the text before it", () => {
    // A paste arrives as one chunk; a trailing newline means "and go".
    expect(readChunk("hello\r")).toEqual({ text: "hello", submit: true });
    expect(readChunk("hello\n")).toEqual({ text: "hello", submit: true });
  });

  it("does not submit on a newline in the middle of a paste", () => {
    const out = readChunk("first line\nsecond line");
    expect(out.submit).toBe(false);
    expect(out.text).toBe("first line second line");
  });

  it("drops control characters that would break the line they land on", () => {
    expect(readChunk("a\u0007b").text).toBe("ab");
    expect(readChunk("a\u0000b").text).toBe("ab");
    expect(readChunk("\u007f").text).toBe("");
  });

  it("passes ordinary text through untouched", () => {
    expect(readChunk("summarise my unread email").text).toBe("summarise my unread email");
  });

  it("keeps non-ASCII, which is most of the world's text", () => {
    expect(readChunk("café — 日本語").text).toBe("café — 日本語");
  });

  it("survives an empty chunk", () => {
    expect(readChunk("")).toEqual({ text: "", submit: false });
  });
});
