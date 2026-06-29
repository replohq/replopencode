# Version-driven opencode packaging + release flow

**Date:** 2026-06-29
**Status:** Design approved, pending implementation plan
**Repos touched:** `replohq/replopencode` (this repo — `install`, release flow) and the Replo monorepo (`apps/daytona-snapshot/Dockerfile`, `sandbox-packages/sandbox-upgrader/src/entries.ts`).

## Problem

Today the opencode fork binary and its runtime npm deps are installed in two
loosely-coupled ways, and a version bump touches several knobs that can drift:

- The Daytona snapshot `curl`s the fork `install` (binary download from GitHub
  Releases) and *separately* runs `apps/daytona-snapshot/prepopulate-opencode-deps.mjs`
  to `npm install @opencode-ai/plugin` + `playwright` into the config dirs at
  **build time only**.
- The live fleet auto-upgrades the binary via a `curlInstall` entry in the
  `sandbox-upgrader`, but **does not** reconcile the npm deps — so a converge can
  move the binary to a new base version while the baked `node_modules` still holds
  the old `@opencode-ai/plugin`. (`package.json` is "a promise the converge can
  make but not keep.")
- Three version knobs (`REPLO_OPENCODE_VERSION`, `OPENCODE_PLUGIN_NPM_VERSION`,
  `PLAYWRIGHT_VERSION`) can drift relative to each other.

We want: **one version controls everything, and the same version-driven install
reconciles fresh boxes (Docker build) and live boxes (converge) identically** —
free from supply-chain risk.

## Goals

- A single pin (`REPLO_OPENCODE_VERSION = <base>-<N>`) drives the binary **and**
  `@opencode-ai/plugin`. Bumping opencode = bump that one value in two files.
- The tag-pinned `install` script is the **single install + prepopulate
  authority**, used identically by the Dockerfile and the converge entry.
- Base-version bumps roll to the **live fleet** via converge (not just fresh
  bakes), because converge now reconciles the plugin too.
- Byte-level supply-chain integrity (checksum) on top of tag-pinning.
- Delete `prepopulate-opencode-deps.mjs`.

## Non-goals / explicitly out of scope

- **Content-addressed binary/`node_modules` blobs.** Rejected: `node_modules` is
  ~58MB and the binary ~138MB; the curl-install design exists to avoid putting
  that in the blob pipeline.
- **Playwright in the opencode upgrade unit.** Verified independent of opencode:
  `prepopulate-opencode-deps.mjs` takes playwright's version as a *separate* arg;
  `@opencode-ai/plugin` and `playwright` are unrelated npm packages; playwright is
  a Replo *tool* dependency (registry-upload tools import it from
  `/root/.config/opencode` only). Playwright keeps its own `PLAYWRIGHT_VERSION`
  ARG and is installed at **build time only**; the chromium browser binary stays
  snapshot-rebuild-only and is never touched by converge.
- **Pruning `node_modules`** (the "strip-test" / removing `effect`/`zod`). A
  worthwhile separate optimization, not required by this design.

## Versioning model (keystone)

`REPLO_OPENCODE_VERSION = <base>-<N>`, e.g. `1.17.9-1`:

- `<base>` — upstream opencode version. Determines `@opencode-ai/plugin@<base>`.
- `<N>` — fork patch iteration.
- Plugin version is **derived** inside the install script: `base="${VERSION%%-*}"`.
  The two cannot drift because one is computed from the other.
- `OPENCODE_PLUGIN_NPM_VERSION` ARG is **deleted** (now derived).
- `PLAYWRIGHT_VERSION` ARG **stays** (orthogonal, build-time only).

SemVer note: `-N` sorts as a pre-release before `<base>`. Harmless because all
Replo consumers pin exactly; only matters for GitHub "latest" on the human
`curl|bash` path, so releases are marked `--latest` manually.

## Component 1 — `install` script (this repo)

The tagged `install` (`…/replopencode/v{version}/install`) gains two
responsibilities beyond installing the binary. It remains a single file so the
human `curl|bash` path keeps working unchanged.

### 1a. Checksum verification (new)

- Each release publishes a `SHA256SUMS` asset covering every archive.
- In `download_and_install()`, **between download (line ~335) and extract (line
  ~337)**: download `SHA256SUMS` from the same release, look up the entry for
  `$filename`, and verify the downloaded archive (`sha256sum -c` / `shasum -a
  256 -c`, with a portable fallback). Abort before extract on mismatch.
- `--binary <path>` local-install path is exempt (no download).

This closes the residual gap tag-pinning leaves: the tag pins *which* release,
the checksum pins *the bytes*.

### 1b. Auto-detect prepopulate (new) — replaces `prepopulate-opencode-deps.mjs`

After the binary is installed, a new `prepopulate_deps()` runs:

- **Hardcoded** config-dir constant (no parameter):
  `/root/.config/opencode`, `/workspace/.opencode`, `/root/.opencode`.
- **Self-gating:** prepopulate only into the dirs that **already exist**. On a
  human laptop none exist → no-op, binary-only. In Docker build / on a sandbox
  all three exist → reconcile. No env flag needed.
- For each existing dir: `npm install --save-exact --package-lock=true
  --workspaces=false --no-audit --no-fund --no-progress --omit=optional
  @opencode-ai/plugin@<derived-base>`, then port the `package.json` creation and
  the `package-lock.json` root-key patch (`lockfile.packages[""].dependencies[pluginSpec]
  = base`) from the old mjs. FATAL if a dir's expected dep is missing afterward
  (preserve the mjs's fail-loud asserts).
- **Playwright (build-time only):** if `OPENCODE_PLAYWRIGHT_VERSION` is set,
  additionally `npm install playwright@<that>` into `/root/.config/opencode`
  (the only dir that gets playwright) and run the existing `import('playwright')`
  smoke test. Converge never sets this env, so playwright is untouched on live
  boxes.

### 1c. `check_version` interaction

`check_version()` early-exits when the requested version already matches the
installed binary. That is the desired idempotent no-op for converge (the upgrader
only invokes the script on a version mismatch). But prepopulate must still run
when the binary matched yet a prior prepopulate failed. Resolution: move the
prepopulate step so it runs **regardless** of the binary early-exit (e.g.
prepopulate before `check_version`'s `exit 0`, or make `check_version` skip only
the download, not the whole script). Decide concretely during implementation;
prepopulate is idempotent (`--save-exact` of a pinned version), so re-running is
safe.

## Component 2 — Dockerfile (`apps/daytona-snapshot/Dockerfile`)

- Collapse the opencode binary install + the separate `prepopulate-opencode-deps.mjs`
  RUN into a **single** call:
  ```dockerfile
  RUN curl -fsSL https://raw.githubusercontent.com/replohq/replopencode/v${REPLO_OPENCODE_VERSION}/install -o /tmp/install-opencode.sh \
      && OPENCODE_PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION}" VERSION="${REPLO_OPENCODE_VERSION}" bash /tmp/install-opencode.sh \
      && rm /tmp/install-opencode.sh
  ```
  (Dirs are created before this RUN so auto-detect picks them up; the existing
  `mkdir -p /workspace/.opencode /root/.opencode` and config COPY ordering must
  precede it.)
- **Delete** `apps/daytona-snapshot/prepopulate-opencode-deps.mjs` and its RUN.
- **Delete** the `OPENCODE_PLUGIN_NPM_VERSION` ARG (now derived).
- **Keep** `PLAYWRIGHT_VERSION` ARG and the `playwright install --with-deps
  chromium` RUN (chromium browser binary, snapshot-only).
- The install URL is already tag-pinned (`v${REPLO_OPENCODE_VERSION}/install`).

## Component 3 — Converge entry (`sandbox-upgrader/src/entries.ts`)

Add/confirm a `curlInstall` `InstallEntry` (the `InstallEntry`/`curlInstall`
machinery from PR #22104 is **already merged**):

```ts
curlInstall({
  target: "opencode",
  version: "1.17.9-1", // = REPLO_OPENCODE_VERSION (the one place besides the Dockerfile)
  script:
    "curl -fsSL https://raw.githubusercontent.com/replohq/replopencode/v{version}/install | VERSION={version} bash",
  probeCommand: "opencode --version",
  probePattern: /* semver capture; matches "Replopencode v1.17.9-1" */,
  onChange: ["restart-opencode"], // idle-aware, never mid-turn
})
```

- **No `OPENCODE_PLAYWRIGHT_VERSION`** → converge reconciles `{binary + plugin}`
  only; playwright untouched.
- Identity is the version string (managed-install entry, not content-addressed);
  on version mismatch converge re-runs the script, then re-probes
  `opencode --version` and asserts.
- Because the plugin is now reconciled at converge, **base-version bumps roll to
  the live fleet** without box recreation. Only chromium bumps remain
  snapshot-only.

## Component 4 — Release flow (supply-chain safe)

Per release `v<base>-<N>` (extends the `release-opencode` skill runbook):

1. Rebase the fork patches onto upstream `<base>` (if base changed).
2. Build the shipped targets incl. `…-baseline`; archive per the skill.
3. **Generate `SHA256SUMS`** over all archives.
4. `gh release create v<base>-<N> … --latest` (stable) or `--prerelease` with no
   `--latest` (staging); upload archives **+ `SHA256SUMS`**; ensure the tag
   carries the updated `install`.
5. Bump `REPLO_OPENCODE_VERSION` in **two** places: the Dockerfile ARG and the
   `entries.ts` `curlInstall` version.

Hard rules (carry over from the skill): every tag must carry a working `install`;
installer changes reach Replo only via a **new release**; **never re-point or
delete a shipped tag** (deployed boxes fetch `install`/assets by tag); keep the
fork repo public (unauthenticated curl).

## Properties this buys us

- One pin → binary + plugin always consistent across fresh and live boxes; no
  drift possible (plugin derived from the pin).
- Supply-chain: tag-pinned URL (immutable ref, not `dev`) **+** byte checksum.
- Base bumps roll to the live fleet (converge reconciles plugin).
- One fewer ARG and one fewer script to maintain.

## Risks / open items

- **Converge egress:** the converge `curl …/v{version}/install | bash` (and the
  `npm install` it triggers) must reach GitHub + the npm registry through the
  sandbox egress proxy. **Verify allowlist on a live box before relying on it.**
  (Was the #1 unverified gate in the prior chat.)
- **`npm install` at converge** is a registry fetch in the converge path. Accepted:
  versions are pinned exact (same trust model as the binary download); the
  supply-chain concern was `bash`-ing a *mutable branch*, now fixed by tag-pinning.
- **`check_version` early-exit vs. prepopulate** — see 1c; settle in implementation.
- **Which config dir opencode resolves the plugin from at runtime** — confirm
  during verification (affects nothing structurally since all three are
  reconciled, but good to know).
- **Playwright independence assumption** holds as long as no opencode base
  requires a specific playwright; they are unrelated npm packages, so it does.

## Implementation touchpoints

| File | Repo | Change |
|------|------|--------|
| `install` | replopencode | checksum verify; `prepopulate_deps()` auto-detect; base derivation; `check_version` ordering |
| release tooling / `release-opencode` skill | replopencode | emit + upload `SHA256SUMS`; doc the `<base>-<N>` + 2-file-bump flow |
| `apps/daytona-snapshot/Dockerfile` | monorepo | single install RUN; drop `OPENCODE_PLUGIN_NPM_VERSION`; keep `PLAYWRIGHT_VERSION` + chromium |
| `apps/daytona-snapshot/prepopulate-opencode-deps.mjs` | monorepo | **delete** |
| `sandbox-packages/sandbox-upgrader/src/entries.ts` | monorepo | `curlInstall` opencode entry (version + probe + `restart-opencode`) |

## Implementation sequencing

The components are built and validated in order, with a hard checkpoint after
Component 1 so the riskiest unknowns surface before any Dockerfile/converge
wiring:

1. **Component 1 — `install` script** (checksum + auto-detect prepopulate + base
   derivation + `check_version` ordering). Also cut a throwaway prerelease (or
   point at a branch `install`) so the script is fetchable by a sandbox.
2. **🔱 Checkpoint: install on a clean sandbox and observe** (see Verification
   step 2 below). This proves auto-detect prepopulate, checksum, **and egress**
   on a real box before we depend on them. Do not proceed until this passes.
3. **Component 3 — converge entry**, then **Component 2 — Dockerfile** (+ delete
   the mjs / drop the ARG), informed by what the checkpoint observed. Converge
   first since the checkpoint already exercises that exact code path on a live box.
4. **Component 4 — release flow** (`SHA256SUMS` emit/upload, runbook + skill
   updates) lands alongside, since the checkpoint and every path above depend on a
   real release carrying the new `install` + checksums.

## Verification plan

1. **Human path unchanged:** `HOME=/tmp/oc-test bash install --version <v>` →
   binary only, no Replo dirs created, checksum verified.
2. **🔱 Clean-sandbox checkpoint (after Component 1):** on a freshly-provisioned
   clean sandbox, run the new tag/branch-pinned `install` exactly as converge
   would (`curl … | VERSION=<v> bash`) and observe:
   - binary installs and `opencode --version` prints `Replopencode v<v>`;
   - the three config dirs are detected and `@opencode-ai/plugin@<base>`
     reconciled into each (lockfile root-key patched), playwright untouched (no
     `OPENCODE_PLAYWRIGHT_VERSION`);
   - **egress works** — the `curl` and the `npm install` both reach GitHub + the
     npm registry through the sandbox proxy (the top risk);
   - checksum verification ran against `SHA256SUMS`.
   Capture anything surprising here before wiring Components 2–4.
3. **Build path:** Docker build with the new single RUN → binary + plugin in all
   three dirs + playwright in `/root/.config/opencode`; smoke test passes.
4. **Converge path (live box):** bump the `entries.ts` version, converge a real
   snapshot box → binary + plugin reconciled, playwright untouched,
   `opencode --version` asserts, idle-aware restart fires.
5. **Tamper test:** corrupt an archive vs. `SHA256SUMS` → install aborts before
   extract.
