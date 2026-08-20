import { describe, expect, it } from "vitest";
import { mimeFor } from "../src/commands/stt.js";

describe("mimeFor", () => {
  // The ASR providers branch on the uploaded part's content type, so the same
  // bytes labelled application/octet-stream can be refused by a provider that
  // would have accepted them.
  it("labels the common audio containers", () => {
    expect(mimeFor("clip.mp3")).toBe("audio/mpeg");
    expect(mimeFor("/tmp/a b/Recording.WAV")).toBe("audio/wav");
    expect(mimeFor("voice.m4a")).toBe("audio/mp4");
    expect(mimeFor("note.ogg")).toBe("audio/ogg");
  });

  it("falls back for an unknown extension", () => {
    expect(mimeFor("clip.xyz")).toBe("application/octet-stream");
    expect(mimeFor("noextension")).toBe("application/octet-stream");
  });
});
