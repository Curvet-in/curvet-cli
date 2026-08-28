import { promises as fs } from "node:fs";
import path from "node:path";
import type { Curvet } from "@curvet/sdk";
import { classifyPath, findProjectRoot, denialMessage } from "../agent/permissions.js";
import { mimeFor } from "../commands/stt.js";
import type { AttachOutcome, AttachResolver, TranscribeResolver } from "./types.js";

/**
 * The half of the MCP server that needs the user's machine.
 *
 * It lives outside `src/mcp/` on purpose: that module is meant to be served from
 * the backend too, where none of this exists. These are the resolvers it takes
 * as dependencies, built for the local stdio host.
 *
 * ### Why there is no confirmation prompt in here
 *
 * `curvet agent` confirms a read outside the project, showing the real
 * destination. There is no terminal here — stdio is the protocol — so the same
 * case is **refused** instead. Non-negotiable #4: a missing confirmation channel
 * is a refusal, never an assumed yes. MCP's `elicitation` could ask, but only
 * when the host implements it, and a permission model that works on some hosts
 * and silently doesn't on others is worse than one that always says no.
 */

/** Bytes an attachment may carry. The server's own multer limit. */
const MAX_ATTACH_BYTES = 50 * 1024 * 1024;

/** Inlined text is cut at 100KB server-side; cut it here so the loss is stated. */
const MAX_INLINE_CHARS = 100_000;

/** Files that go up as bytes rather than as text: the model reads the document. */
const BINARY_ATTACHABLE = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "xlsx", "xlsm", "xltx"]);

/** Audio the transcription endpoint accepts. */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

function extOf(p: string): string {
  return (p.split(/[\\/]/).pop() ?? "").split(".").pop()?.toLowerCase() ?? "";
}

/** Where the boundary is measured from: the project, or the cwd if there is none. */
export async function attachmentRoot(cwd: string): Promise<string> {
  return (await findProjectRoot(cwd)) ?? cwd;
}

export function makeAttachResolver(client: Curvet, root: string, sessionId?: string): AttachResolver {
  return async (request: string): Promise<AttachOutcome> => {
    const verdict = await classifyPath(root, request);

    if (verdict.decision === "deny") {
      return { ok: false, reason: denialMessage(request, verdict.matched) };
    }
    if (verdict.decision === "confirm") {
      return {
        ok: false,
        reason:
          `Refused: "${request}" is outside the project (${verdict.display}), and this server has no way ` +
          "to ask the user to approve it — MCP has no terminal. Copy the file into the project, or run " +
          "`curvet agent` where the user can approve it.",
      };
    }

    let stat;
    try {
      stat = await fs.stat(verdict.abs);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return { ok: false, reason: `"${request}" does not exist.` };
      return { ok: false, reason: `Could not read "${request}": ${e.message}` };
    }
    if (stat.isDirectory()) {
      return { ok: false, reason: `"${request}" is a directory. Name the files inside it instead.` };
    }
    if (stat.size === 0) return { ok: false, reason: `"${request}" is empty.` };
    if (stat.size > MAX_ATTACH_BYTES) {
      return {
        ok: false,
        reason: `"${request}" is ${Math.round(stat.size / 1024 / 1024)}MB, over the 50MB limit.`,
      };
    }

    const name = path.basename(verdict.abs);

    // A PDF, an image or a spreadsheet goes up as bytes: pasting it in as text
    // is a transcription of the document rather than the document, and a photo
    // cannot be one at all.
    if (BINARY_ATTACHABLE.has(extOf(name))) {
      try {
        const bytes = await fs.readFile(verdict.abs);
        const parked = await client.agency.attach({ data: bytes, name, sessionId });
        return { ok: true, attachment: { id: parked.id, name: parked.name || name } };
      } catch (err) {
        return { ok: false, reason: `Could not attach "${request}": ${(err as Error).message}` };
      }
    }

    try {
      const text = await fs.readFile(verdict.abs, "utf8");
      const cut = text.length > MAX_INLINE_CHARS;
      return {
        ok: true,
        attachment: {
          name,
          content: cut
            ? `${text.slice(0, MAX_INLINE_CHARS)}\n\n[… ${name} is ${text.length} characters and was cut at ${MAX_INLINE_CHARS} …]`
            : text,
        },
      };
    } catch (err) {
      return { ok: false, reason: `Could not read "${request}" as text: ${(err as Error).message}` };
    }
  };
}

export function makeTranscribeResolver(client: Curvet, root: string): TranscribeResolver {
  return async ({ file, model, language }) => {
    // Same gate as an attachment. Audio is not obviously credential-shaped,
    // which is exactly why it goes through the same check rather than a looser
    // one — the boundary is the path, not the file type.
    const verdict = await classifyPath(root, file);
    if (verdict.decision === "deny") throw new Error(denialMessage(file, verdict.matched));
    if (verdict.decision === "confirm") {
      throw new Error(
        `Refused: "${file}" is outside the project (${verdict.display}), and there is no way to ask ` +
          "the user to approve it here. Use `curvet stt` instead.",
      );
    }

    const bytes = await fs.readFile(verdict.abs);
    if (bytes.length > MAX_AUDIO_BYTES) {
      throw new Error(`${file} is over the 10 MB upload limit.`);
    }
    const result = await client.voice.stt({
      audio: new Blob([bytes], { type: mimeFor(verdict.abs) }),
      filename: path.basename(verdict.abs),
      model,
      languageCode: language,
    });
    return {
      text: result.text,
      provider: result.provider,
      languageCode: result.languageCode,
      creditsCharged: result.creditsCharged,
    };
  };
}
