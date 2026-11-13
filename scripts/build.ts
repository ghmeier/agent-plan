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
