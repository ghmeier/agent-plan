import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { AgentPlanError } from "./errors";
import type { PlanMeta } from "./frontmatter";
import { warn } from "./output";

export interface DocType {
  name: string;
  description?: string;
  statuses: string[];
  defaultStatus: string;
}

/** Statuses for docs outside any type directory, and for types that don't list their own. */
export const DEFAULT_STATUSES = ["draft", "active", "completed", "archived"];

export const BUILTIN_TYPES: DocType[] = [
  {
    name: "plan",
    description: "Implementation plans",
    statuses: DEFAULT_STATUSES,
    defaultStatus: "draft",
  },
  {
    name: "research",
    description: "Investigation notes and findings",
    statuses: ["draft", "final", "archived"],
    defaultStatus: "draft",
  },
  {
    name: "handoff",
    description: "Context for the next person or session picking up the work",
    statuses: ["open", "picked-up", "closed"],
    defaultStatus: "open",
  },
];

const TYPE_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** The team-wide config committed at the root of the docs branch. */
export const STORE_CONFIG_FILE = "config.json";

export const TEMPLATES_DIR = ".templates";

function invalidConfig(configPath: string, problem: string): AgentPlanError {
  return new AgentPlanError(`Invalid ${configPath}: ${problem}`);
}

function parseType(name: string, raw: unknown, configPath: string): DocType {
  if (!TYPE_NAME_RE.test(name)) {
    throw invalidConfig(
      configPath,
      `type name "${name}" must be lowercase letters, digits, and dashes, starting with a letter`,
    );
  }
  const spec = (raw ?? {}) as Record<string, unknown>;
  if (typeof spec !== "object" || Array.isArray(spec)) {
    throw invalidConfig(configPath, `type "${name}" must be an object`);
  }

  const statuses = spec.statuses ?? DEFAULT_STATUSES;
  if (
    !Array.isArray(statuses) ||
    statuses.length === 0 ||
    !statuses.every((s) => typeof s === "string")
  ) {
    throw invalidConfig(
      configPath,
      `"statuses" for type "${name}" must be a non-empty string list`,
    );
  }

  const defaultStatus = spec.defaultStatus ?? statuses[0];
  if (typeof defaultStatus !== "string" || !statuses.includes(defaultStatus)) {
    throw invalidConfig(
      configPath,
      `"defaultStatus" for type "${name}" must be one of its statuses`,
    );
  }

  return {
    name,
    description: typeof spec.description === "string" ? spec.description : undefined,
    statuses,
    defaultStatus,
  };
}

/**
 * Returns the doc types for this store: the `types` in the committed
 * config.json when it has them, which replace the built-ins entirely, or
 * the built-ins otherwise.
 */
export async function readDocTypes(storeDir: string): Promise<DocType[]> {
  const configPath = path.join(storeDir, STORE_CONFIG_FILE);
  const file = Bun.file(configPath);
  if (!(await file.exists())) return BUILTIN_TYPES;
  return parseStoreConfig(await file.text(), configPath);
}

export function parseStoreConfig(text: string, configPath: string): DocType[] {
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw invalidConfig(configPath, "could not parse JSON");
  }

  const types = (config as { types?: unknown } | null)?.types;
  if (types === undefined) return BUILTIN_TYPES;
  if (typeof types !== "object" || types === null || Array.isArray(types)) {
    throw invalidConfig(configPath, '"types" must be an object keyed by type name');
  }

  return Object.entries(types).map(([name, spec]) => parseType(name, spec, configPath));
}

export function findType(types: DocType[], name: string): DocType {
  const type = types.find((t) => t.name === name);
  if (!type) {
    throw new AgentPlanError(
      `Unknown doc type "${name}". Valid types: ${types.map((t) => t.name).join(", ")}`,
    );
  }
  return type;
}

/** A doc's type is its top-level directory, when that directory is a known type. */
export function typeOf(docPath: string, types: DocType[]): DocType | null {
  const [first, ...rest] = docPath.split("/");
  if (rest.length === 0) return null;
  return types.find((t) => t.name === first) ?? null;
}

/**
 * Drops a status that isn't valid for the doc's type from `meta`, with a
 * warning. The file itself is never changed.
 */
export function withValidStatus(meta: PlanMeta, type: DocType | null, docPath: string): PlanMeta {
  if (meta.status === undefined) return meta;
  const statuses = type?.statuses ?? DEFAULT_STATUSES;
  if (statuses.includes(meta.status)) return meta;

  const kind = type ? `${type.name} docs` : "docs outside a type directory";
  warn(
    `Unknown status value "${meta.status}" in ${docPath} (valid for ${kind}: ${statuses.join(", ")}) — ignoring`,
  );
  const { status: _dropped, ...rest } = meta;
  return rest;
}

const TEMPLATE_SECTIONS: Record<string, string[]> = {
  plan: ["Goal", "Approach", "Steps", "Risks"],
  research: ["Question", "Findings", "Sources", "Open questions"],
  handoff: ["Context", "Done", "In progress", "Next steps", "Gotchas"],
};

function builtinTemplate(typeName: string): string {
  const extraFields = typeName === "handoff" ? "branch: {{branch}}\n" : "";
  const sections = (TEMPLATE_SECTIONS[typeName] ?? []).map((s) => `\n## ${s}\n`).join("");
  return `---\ntitle: {{title}}\nstatus: {{status}}\ntags: []\n${extraFields}---\n# {{title}}\n${sections}`;
}

export type TemplateSource = "custom" | "builtin" | "default";

/** A type's template: `.templates/<type>.md` in the store, else a built-in one. */
export async function resolveTemplate(
  storeDir: string,
  typeName: string,
): Promise<{ text: string; source: TemplateSource }> {
  const custom = Bun.file(path.join(storeDir, TEMPLATES_DIR, `${typeName}.md`));
  if (await custom.exists()) return { text: await custom.text(), source: "custom" };
  const source = typeName in TEMPLATE_SECTIONS ? "builtin" : "default";
  return { text: builtinTemplate(typeName), source };
}

const FRONTMATTER_RE = /^(---\r?\n[\s\S]*?\n---\r?\n?)([\s\S]*)$/;

/**
 * Fills `{{name}}` placeholders. Inside frontmatter, values are YAML-quoted
 * when needed, so a title like "Auth: phase 2" stays valid YAML; in the
 * body they are inserted as-is. Unknown placeholders are left alone.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const fill = (text: string, format: (value: string) => string) =>
    text.replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) =>
      key in vars ? format(vars[key] ?? "") : placeholder,
    );

  const match = FRONTMATTER_RE.exec(template);
  if (!match) return fill(template, (v) => v);
  const [, frontmatter = "", body = ""] = match;
  return fill(frontmatter, yamlScalar) + fill(body, (v) => v);
}

export function yamlScalar(value: string): string {
  return stringifyYaml(value).trimEnd();
}

export function yamlFlowList(values: string[]): string {
  // Plain scalars can't contain flow indicators like "," inside a list, so
  // anything beyond simple words is written as a JSON string, which is valid YAML.
  const items = values.map((v) => (/^[\w./-]+$/.test(v) ? v : JSON.stringify(v)));
  return `[${items.join(", ")}]`;
}
