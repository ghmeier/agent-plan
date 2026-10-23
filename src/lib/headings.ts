import { parseFrontmatter } from "./frontmatter";

export interface Heading {
  /** 1-based line number in the file as stored, frontmatter included. */
  line: number;
  level: number;
  text: string;
}

export interface Section extends Heading {
  /** The heading line and everything up to the next heading at the same or a higher level. */
  content: string;
}

const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * ATX headings in a doc's body. Lines inside fenced code blocks are skipped,
 * because plans often quote shell snippets whose `# comments` would otherwise
 * read as headings.
 */
export function findHeadings(content: string): Heading[] {
  const lines = content.split("\n");
  const body = parseFrontmatter(content).content;
  const firstBodyIndex = lines.length - body.split("\n").length;

  const headings: Heading[] = [];
  let openFence: string | null = null;
  for (let index = firstBodyIndex; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const fence = FENCE_RE.exec(line)?.[1];
    if (openFence) {
      if (fence && fence[0] === openFence[0] && fence.length >= openFence.length) openFence = null;
      continue;
    }
    if (fence) {
      openFence = fence;
      continue;
    }

    const match = HEADING_RE.exec(line);
    if (match) {
      headings.push({ line: index + 1, level: match[1]?.length ?? 1, text: match[2] ?? "" });
    }
  }
  return headings;
}

/**
 * Every section whose heading contains `query`, case-insensitively. A match
 * nested inside a section already being returned is skipped so no text
 * prints twice.
 */
export function findSections(content: string, query: string): Section[] {
  const lines = content.split("\n");
  const headings = findHeadings(content);
  const needle = query.toLowerCase();

  const sections: Section[] = [];
  let coveredUntil = 0;
  headings.forEach((heading, i) => {
    if (heading.line <= coveredUntil || !heading.text.toLowerCase().includes(needle)) return;

    const next = headings.slice(i + 1).find((h) => h.level <= heading.level);
    const endLine = next ? next.line - 1 : lines.length;
    const text = lines
      .slice(heading.line - 1, endLine)
      .join("\n")
      .trimEnd();
    sections.push({ ...heading, content: `${text}\n` });
    coveredUntil = endLine;
  });
  return sections;
}
