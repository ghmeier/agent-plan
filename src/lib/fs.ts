import { readFile, stat } from "node:fs/promises";

/** True when `p` is a regular file (following symlinks). False for directories and missing paths. */
export async function fileExists(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isFile() ?? false;
}

export function readText(p: string): Promise<string> {
  return readFile(p, "utf8");
}

/** The file's contents, or null when `p` is not a regular file. */
export async function readTextIfExists(p: string): Promise<string | null> {
  return (await fileExists(p)) ? readText(p) : null;
}

/** Reads all of stdin as text. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
