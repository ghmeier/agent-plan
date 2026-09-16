import { readdir } from "node:fs/promises";
import { join } from "node:path";

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
    // Skip git internals.
    if (entry.name === ".git") continue;

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
