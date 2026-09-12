# CLI Distribution

## Problem

Running `bun run src/index.ts` works for development but isn't a real distribution story. Users need a `plan` command that works globally without cloning the repo or having Bun installed.

## Solution

Ship the CLI through multiple channels depending on the user's environment: a global Bun install for Bun users, a compiled standalone binary for everyone else, and npm as a discovery mechanism.

### Distribution Channels

**1. `bun link` (development / local install)**
Already partially works thanks to the `bin` entry in `package.json`. Running `bun link` in the repo makes `plan` available globally for the current user.

**2. npm package**
Publish to npm so `bunx plan-storage` or `npx plan-storage` works. The `bin` field in `package.json` points to `src/index.ts` with the `#!/usr/bin/env bun` shebang, so it requires Bun on the user's machine.

**3. Compiled binary via `bun build --compile`**
Bun can compile a TypeScript entrypoint into a self-contained executable with no runtime dependency. This is the primary path for users who don't have Bun installed. Produces a single binary per platform (macOS arm64, macOS x64, Linux x64).

## Implementation

### Wave 1: Local Install

**Task 1: Fix `package.json` bin entry**
- Ensure `"bin": { "plan": "src/index.ts" }` is set correctly
- Verify the shebang line `#!/usr/bin/env bun` is present in `src/index.ts`
- Test `bun link` and confirm `plan --help` works from any directory
- Test `plan init`, `plan add`, `plan ls` from a different repo

### Wave 2: Compiled Binary

**Task 2: Add build script**
- Add `"build"` script to `package.json`: `bun build src/index.ts --compile --outfile dist/plan`
- Add `dist/` to `.gitignore`
- Test the compiled binary works without Bun installed (e.g., in a clean Docker container)

**Task 3: Cross-compilation**
- Add build targets for macOS arm64, macOS x64, and Linux x64
- Script: `bun build src/index.ts --compile --target=bun-linux-x64 --outfile dist/plan-linux-x64` (and similar for each target)
- Add a `build:all` script that produces all three

### Wave 3: Publishing

**Task 4: npm publish**
- Set `"name"`, `"version"`, `"description"`, `"license"`, `"repository"` in `package.json`
- Add `"files"` field to include only `src/` and `package.json`
- Add a `prepublishOnly` script that runs tests
- Test with `npm pack` and inspect the tarball before publishing
- Publish with `npm publish`

**Task 5: GitHub Releases with binaries**
- Add a GitHub Actions workflow that triggers on version tags (`v*`)
- Build compiled binaries for each platform
- Upload them as release assets
- Include install instructions in the release notes: download binary, `chmod +x`, move to PATH

**Task 6: Install script (optional)**
- A `curl | sh` one-liner that detects the platform and downloads the right binary
- Puts it in `~/.local/bin` or `/usr/local/bin`
- Not strictly necessary if GitHub release instructions are clear enough

## Open Questions

- **Package name**: `plan-storage` is descriptive but long. `plan` is taken on npm. Candidates: `@anthropic/plan`, `git-plan`, `plan-cli`.
- **Auto-update**: Should the CLI check for new versions? Probably not worth the complexity early on, but worth considering once there are real users.
- **Homebrew**: A tap would be nice for macOS users but is extra maintenance. Defer until there's demand.
