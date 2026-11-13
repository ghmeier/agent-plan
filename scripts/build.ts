/**
 * Builds the npm package's CLI: one Node ESM file with its dependencies bundled
 * in, so installing it pulls no other packages and runs no install scripts.
 * The licenses of the bundled packages go next to it.
 */
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outdir = join(root, "dist");

const result = await Bun.build({
  entrypoints: [join(root, "src", "index.ts")],
  outdir,
  naming: "apl.js",
  target: "node",
  format: "esm",
  metafile: true,
});
if (!result.success || !result.metafile) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// A `node` shebang breaks `bun i -g` on machines without Node, so the bundle
// starts with a line that sh runs and JavaScript ignores (a string, then a
// comment), which picks Node when it's installed and Bun otherwise. sh never
// gets past that line: it execs a runtime or exits. The lone `;` on the next
// line ends the string's statement for JavaScript, so the bundle's first line
// can't be parsed as a continuation of it.
const LAUNCHER = [
  "#!/bin/sh",
  `":" //; if command -v node >/dev/null 2>&1; then exec node "$0" "$@"; fi; if command -v bun >/dev/null 2>&1; then exec bun "$0" "$@"; fi; echo "apl needs Node 22+ or Bun, and neither is on PATH" >&2; exit 127`,
  ";",
  "",
].join("\n");
const bundlePath = join(outdir, "apl.js");
const bundle = await Bun.file(bundlePath).text();
await Bun.write(bundlePath, LAUNCHER + bundle.replace(/^#!.*\n/, ""));

const bundled = new Set<string>();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (match?.[1]) bundled.add(match[1]);
}

const notices: string[] = [];
for (const name of [...bundled].sort()) {
  const dir = join(root, "node_modules", name);
  const { version, license } = await Bun.file(join(dir, "package.json")).json();
  const licenseFile = Bun.file(join(dir, "LICENSE"));
  if (!(await licenseFile.exists())) {
    console.error(`${name} has no LICENSE file to include in dist/THIRD_PARTY_LICENSES`);
    process.exit(1);
  }
  notices.push(`${name}@${version} (${license})\n\n${(await licenseFile.text()).trim()}\n`);
}
await Bun.write(join(outdir, "THIRD_PARTY_LICENSES"), notices.join(`\n${"-".repeat(72)}\n\n`));
console.log(`Built dist/apl.js, bundling ${[...bundled].sort().join(", ")}`);
