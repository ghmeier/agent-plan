import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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

  let parsed: Record<string, unknown>;
  try {
    parsed = (parseYaml(yamlBlock) as Record<string, unknown>) ?? {};
  } catch {
    // Malformed YAML — treat the file as if there's no frontmatter.
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

/** Serialize PlanMeta back to a YAML frontmatter block prepended to body.
 * Fields with undefined values are omitted from the output. */
export function serializeFrontmatter(meta: PlanMeta, body: string): string {
  const obj: Record<string, unknown> = {};
  if (meta.title !== undefined) obj.title = meta.title;
  if (meta.status !== undefined) obj.status = meta.status;
  if (meta.tags !== undefined) obj.tags = meta.tags;
  if (meta.created !== undefined) obj.created = meta.created;
  if (meta.updated !== undefined) obj.updated = meta.updated;

  const yaml = stringifyYaml(obj).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

/** Return today's date as an ISO date string (YYYY-MM-DD). */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Inject or update `updated` (and `created` if absent) into a file that
 * already has frontmatter. Files without frontmatter are returned as-is.
 */
export function stampTimestamps(raw: string): string {
  const parsed = parseFrontmatter(raw);
  if (!parsed.hasFrontmatter) return raw;

  const date = today();
  parsed.meta.updated = date;
  if (!parsed.meta.created) parsed.meta.created = date;

  return serializeFrontmatter(parsed.meta, parsed.content);
}
