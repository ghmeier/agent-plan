import { parse as parseYaml } from "yaml";

export interface PlanMeta {
  title?: string;
  /** Any string as written. Which statuses are valid depends on the doc's type. */
  status?: string;
  tags?: string[];
  created?: string;
  updated?: string;
}

export interface ParsedPlan {
  meta: PlanMeta;
  content: string;
  /** True when the original file contained a YAML frontmatter block. */
  hasFrontmatter: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FENCE_RE = /^---\r?\n([\s\S]*?)\n---\r?\n?([\s\S]*)$/;

/** Parse YAML frontmatter from markdown content. Files without a frontmatter
 * block are returned unchanged with an empty meta and hasFrontmatter=false. */
export function parseFrontmatter(raw: string): ParsedPlan {
  const match = FENCE_RE.exec(raw);
  if (!match) {
    return { meta: {}, content: raw, hasFrontmatter: false };
  }

  const yamlBlock = match[1] ?? "";
  const body = match[2] ?? "";

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock) ?? {};
  } catch {
    // Malformed YAML — treat the file as if there's no frontmatter.
    return { meta: {}, content: raw, hasFrontmatter: false };
  }
  if (!isRecord(parsed)) {
    return { meta: {}, content: raw, hasFrontmatter: false };
  }

  const meta: PlanMeta = {};

  if (typeof parsed.title === "string") meta.title = parsed.title;

  if (typeof parsed.status === "string") meta.status = parsed.status;

  if (Array.isArray(parsed.tags)) {
    meta.tags = parsed.tags.filter((t): t is string => typeof t === "string");
  }

  if (typeof parsed.created === "string") meta.created = parsed.created;
  if (typeof parsed.updated === "string") meta.updated = parsed.updated;

  return { meta, content: body, hasFrontmatter: true };
}

/** Return today's date as an ISO date string (YYYY-MM-DD). */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Sets top-level frontmatter keys to already-serialized YAML values, in a
 * file that already has frontmatter. Keys in `fields` are replaced or
 * appended; keys in `missingFields` are appended only when absent. Files
 * without frontmatter are returned as-is.
 *
 * Only those lines are touched, so other keys, comments, and formatting stay
 * exactly as the author wrote them.
 */
export function setFrontmatterFields(
  raw: string,
  fields: Record<string, string>,
  missingFields: Record<string, string> = {},
): string {
  const match = FENCE_RE.exec(raw);
  if (!match || !parseFrontmatter(raw).hasFrontmatter) return raw;

  const yamlStart = raw.indexOf("\n") + 1;
  const yamlBlock = match[1] ?? "";
  const lines = yamlBlock.length > 0 ? yamlBlock.split("\n") : [];
  const indexOfKey = (key: string) => lines.findIndex((line) => line.startsWith(`${key}:`));

  for (const [key, value] of Object.entries(missingFields)) {
    if (indexOfKey(key) === -1) lines.push(`${key}: ${value}`);
  }
  for (const [key, value] of Object.entries(fields)) {
    const index = indexOfKey(key);
    if (index === -1) lines.push(`${key}: ${value}`);
    else lines[index] = `${key}: ${value}`;
  }

  return raw.slice(0, yamlStart) + lines.join("\n") + raw.slice(yamlStart + yamlBlock.length);
}

/** Sets `updated` to today, and `created` too if it's missing. See `setFrontmatterFields`. */
export function stampTimestamps(raw: string): string {
  const date = today();
  return setFrontmatterFields(raw, { updated: date }, { created: date });
}
