import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** True for a path that `ls` and completion treat as a doc: markdown outside dot-directories. */
export function isDocPath(relPath: string): boolean {
  return relPath.endsWith(".md") && !relPath.split("/").some((part) => part.startsWith("."));
}

/** Recursively lists .md files under dir, returning repo-relative posix paths. */
export async function listMarkdownFiles(dir: string, base = dir): Promise<string[]> {
  const results: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: bun types differ from Node types for Dirent
  let entries: any[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    // Dot entries are git internals and apl's own files, such as `.templates/`.
    if (entry.name.startsWith(".")) continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listMarkdownFiles(fullPath, base)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      // Use posix separators for consistent cross-platform output.
      const rel = fullPath
        .slice(base.length + 1)
        .split(/[\\/]/)
        .join("/");
      results.push(rel);
    }
  }

  return results.sort();
}
