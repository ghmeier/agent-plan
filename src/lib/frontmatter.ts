import { parse as parseYaml } from "yaml";
import { warn } from "./output";

export const VALID_STATUSES = ["draft", "active", "completed", "archived"] as const;
export type PlanStatus = (typeof VALID_STATUSES)[number];

export interface PlanMeta {
  title?: string;
  status?: PlanStatus;
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

  if (typeof parsed.status === "string") {
    if ((VALID_STATUSES as readonly string[]).includes(parsed.status)) {
      meta.status = parsed.status as PlanStatus;
    } else {
      warn(`Unknown status value "${parsed.status}" — ignoring`);
    }
  }

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
 * Sets `updated` to today, and `created` too if it's missing, in a file that
 * already has frontmatter. Files without frontmatter are returned as-is.
 *
 * Only those lines are touched, so other keys, comments, and formatting stay
 * exactly as the author wrote them.
 */
export function stampTimestamps(raw: string): string {
  const match = FENCE_RE.exec(raw);
  if (!match || !parseFrontmatter(raw).hasFrontmatter) return raw;

  const yamlStart = raw.indexOf("\n") + 1;
  const yamlBlock = match[1] ?? "";
  const date = today();

  const lines = yamlBlock.length > 0 ? yamlBlock.split("\n") : [];
  const hasKey = (key: string) => lines.some((line) => line.startsWith(`${key}:`));

  if (!hasKey("created")) lines.push(`created: ${date}`);
  if (hasKey("updated")) {
    const index = lines.findIndex((line) => line.startsWith("updated:"));
    lines[index] = `updated: ${date}`;
  } else {
    lines.push(`updated: ${date}`);
  }

  return raw.slice(0, yamlStart) + lines.join("\n") + raw.slice(yamlStart + yamlBlock.length);
}
