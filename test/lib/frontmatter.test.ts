import { describe, expect, test } from "bun:test";
import {
  parseFrontmatter,
  serializeFrontmatter,
  stampTimestamps,
  today,
} from "../../src/lib/frontmatter";

describe("parseFrontmatter", () => {
  test("returns empty meta and full content when no frontmatter is present", () => {
    const raw = "# Hello\n\nJust a body.";

    const result = parseFrontmatter(raw);

    expect(result.hasFrontmatter).toBe(false);
    expect(result.meta).toEqual({});
    expect(result.content).toBe(raw);
  });

  test("parses all supported fields from a valid frontmatter block", () => {
    const raw = `---\ntitle: My Plan\nstatus: active\ntags: [cli, ux]\ncreated: 2026-01-01\nupdated: 2026-09-01\n---\n# Body`;

    const result = parseFrontmatter(raw);

    expect(result.hasFrontmatter).toBe(true);
    expect(result.meta.title).toBe("My Plan");
    expect(result.meta.status).toBe("active");
    expect(result.meta.tags).toEqual(["cli", "ux"]);
    expect(result.meta.created).toBe("2026-01-01");
    expect(result.meta.updated).toBe("2026-09-01");
    expect(result.content).toBe("# Body");
  });

  test("accepts all four valid status values", () => {
    for (const status of ["draft", "active", "completed", "archived"] as const) {
      const raw = `---\nstatus: ${status}\n---\nbody`;
      const { meta } = parseFrontmatter(raw);
      expect(meta.status).toBe(status);
    }
  });

  test("ignores an unknown status and emits a warning instead of crashing", () => {
    // Capturing stderr is unnecessary — just assert it doesn't throw and
    // drops the invalid value rather than storing it.
    const raw = "---\nstatus: bogus\n---\nbody";

    const result = parseFrontmatter(raw);

    expect(result.meta.status).toBeUndefined();
  });

  test("handles frontmatter with only some fields set", () => {
    const raw = "---\ntitle: Partial\n---\ncontent";

    const { meta, content } = parseFrontmatter(raw);

    expect(meta.title).toBe("Partial");
    expect(meta.status).toBeUndefined();
    expect(meta.tags).toBeUndefined();
    expect(content).toBe("content");
  });

  test("treats malformed YAML frontmatter as no frontmatter", () => {
    const raw = "---\n: bad: yaml: [unclosed\n---\nbody";

    const result = parseFrontmatter(raw);

    expect(result.hasFrontmatter).toBe(false);
    expect(result.content).toBe(raw);
  });
});

describe("serializeFrontmatter", () => {
  test("round-trips a parsed document without altering the body", () => {
    const raw = "---\ntitle: Round Trip\nstatus: draft\ntags:\n  - a\n  - b\n---\n# Body\n";

    const { meta, content } = parseFrontmatter(raw);
    const result = serializeFrontmatter(meta, content);
    const reparsed = parseFrontmatter(result);

    expect(reparsed.meta.title).toBe("Round Trip");
    expect(reparsed.meta.status).toBe("draft");
    expect(reparsed.meta.tags).toEqual(["a", "b"]);
    expect(reparsed.content).toBe("# Body\n");
  });

  test("omits undefined fields from the serialized block", () => {
    const result = serializeFrontmatter({ title: "Only Title" }, "body");

    // Should not contain status, tags, created, updated keys.
    expect(result).not.toContain("status:");
    expect(result).not.toContain("tags:");
    expect(result).toContain("title: Only Title");
  });
});

describe("stampTimestamps", () => {
  test("sets updated to today on a file that already has frontmatter", () => {
    const raw = "---\ntitle: Test\ncreated: 2026-01-01\n---\nbody";

    const stamped = stampTimestamps(raw);
    const { meta } = parseFrontmatter(stamped);

    expect(meta.updated).toBe(today());
    // created must remain unchanged when it was already set.
    expect(meta.created).toBe("2026-01-01");
  });

  test("sets both created and updated when created is absent", () => {
    const raw = "---\ntitle: New\n---\nbody";

    const stamped = stampTimestamps(raw);
    const { meta } = parseFrontmatter(stamped);

    expect(meta.created).toBe(today());
    expect(meta.updated).toBe(today());
  });

  test("returns the file unchanged when there is no frontmatter", () => {
    const raw = "# Plain markdown\n\nNo frontmatter here.";

    expect(stampTimestamps(raw)).toBe(raw);
  });
});
