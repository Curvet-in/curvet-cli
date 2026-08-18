import { promises as fs } from "node:fs";
import path from "node:path";

/** Human-readable byte count. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Best-effort extension for a generated asset. Media URLs are usually signed,
 * so the query string has to come off before the extension means anything.
 */
export function extensionFor(url: string, fallback: string): string {
  try {
    const ext = path.extname(new URL(url).pathname);
    return ext && ext.length <= 6 ? ext : fallback;
  } catch {
    return fallback;
  }
}

/** Download a generated asset to disk. Returns the byte count written. */
export async function downloadTo(url: string, dest: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Could not download the result (HTTP ${res.status}) from ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = path.dirname(path.resolve(dest));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(dest, buf);
  return buf.length;
}
