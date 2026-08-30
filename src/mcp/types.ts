/**
 * The seam between the tool module and whatever is hosting it.
 *
 * Everything the tools need that is NOT the Curvet client arrives through here,
 * so the same module can be served from a local process that has a filesystem
 * and from the backend, which does not. A capability the host cannot provide is
 * absent rather than stubbed — the tools check for it and say so.
 */

/** A file the agent may read, in one of the two forms `run()` accepts. */
export interface ResolvedAttachment {
  name: string;
  /** Parked-upload id, for anything that is not plain text. */
  id?: string;
  /** Already-extracted text. */
  content?: string;
}

export type AttachOutcome =
  | { ok: true; attachment: ResolvedAttachment }
  | { ok: false; reason: string };

/**
 * Turn a path the model named into something a run can read.
 *
 * Supplied only by a host that shares a filesystem with the user. It owns the
 * permission decision: secrets refused before the file is opened, and anything
 * outside the project refused outright — not confirmed, because there is no
 * terminal here to confirm on.
 */
export type AttachResolver = (request: string) => Promise<AttachOutcome>;

/** Transcription needs the file's bytes, so it too belongs to a host with a disk. */
export type TranscribeResolver = (params: {
  file: string;
  model?: string;
  language?: string;
}) => Promise<Record<string, unknown>>;
