# Version-driven opencode packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one version pin install the opencode fork binary together with its `@opencode-ai/plugin` dependency, via a tag-pinned `install` script used identically by the Daytona Dockerfile and the sandbox-upgrader converge entry.

**Architecture:** The tagged `install` script gains (a) SHA256 checksum verification of the downloaded archive and (b) an auto-detecting prepopulate step that `npm install`s `@opencode-ai/plugin@<base>` into whichever Replo config dirs exist (base derived from the version). The Daytona Dockerfile and the converge entry both call this one script. `prepopulate-opencode-deps.mjs` is deleted; playwright stays an independent, build-time-only concern.

**Tech Stack:** Bash (the `install` script), Dockerfile, TypeScript (sandbox-upgrader `entries.ts`), npm, `gh` CLI, GitHub Releases.

## Global Constraints

- **Version format:** `REPLO_OPENCODE_VERSION = <base>-<N>` (e.g. `1.17.9-1`). `<base>` = upstream opencode version; `<N>` = fork patch iteration.
- **Plugin version is derived, never specified:** `base="${version%%-*}"` → `@opencode-ai/plugin@<base>`.
- **Repo split:** fork changes (`install`, release flow) → cwd `/Users/andrew/code/replopencode` on branch `feat/versioned-opencode-packaging`. Codebase changes (Dockerfile, `entries.ts`, delete the mjs) → `/Users/andrew/code/worktree-1`, on a **new branch off `origin/main`** (the `curlInstall` machinery from PR #22104 is on `main`, not the current worktree branch).
- **Config dirs are fixed** (no user-facing flag): `/root/.config/opencode`, `/workspace/.opencode`, `/root/.opencode`. `OPENCODE_PREPOPULATE_DIRS` exists only as a test seam, defaulting to that exact set.
- **Self-gating:** prepopulate only touches dirs that already exist → human `curl|bash` is binary-only.
- **Playwright is out of the opencode upgrade unit:** installed only into `/root/.config/opencode`, only when `OPENCODE_PLAYWRIGHT_VERSION` is set (Dockerfile build only; never on converge). Keeps `PLAYWRIGHT_VERSION` ARG; chromium browser binary stays snapshot-only.
- **Supply-chain rules:** install URL pinned to `v<version>` (never `dev`); every release tag carries a working `install`; every release publishes `SHA256SUMS`; **never re-point or delete a shipped tag**; keep the fork repo public.
- **One version, two files to bump:** `entries.ts` curlInstall `version` and the Dockerfile `REPLO_OPENCODE_VERSION` ARG.

---

## File Structure

| File | Repo | Responsibility |
|------|------|----------------|
| `install` | fork (cwd) | binary download + checksum verify + auto-detect plugin prepopulate |
| `~/.claude/skills/release-opencode/SKILL.md` | personal skill | release runbook (adds SHA256SUMS + `<base>-<N>` + 2-file-bump) |
| `apps/daytona-snapshot/Dockerfile` | monorepo | single version-driven install RUN; drop derived ARG; keep playwright |
| `apps/daytona-snapshot/prepopulate-opencode-deps.mjs` | monorepo | **deleted** |
| `sandbox-packages/sandbox-upgrader/src/entries.ts` | monorepo | opencode `curlInstall` converge entry |

---

## Task 1: `install` — auto-detect plugin prepopulate (fork repo)

**Files:**
- Modify: `/Users/andrew/code/replopencode/install` (`--binary` branch ~line 354; `check_version` ~line 221; main install block ~line 354-359; add new functions before that block)
- Test: `/Users/andrew/code/replopencode/scratch-test-prepopulate.sh` (throwaway, not committed)

**Interfaces:**
- Consumes: `$specific_version` (set by existing version-resolution logic), `$INSTALL_DIR`, `print_message`, `$MUTED/$NC/$RED`.
- Produces: `prepopulate_deps()` (reads `$specific_version`, `$PREPOPULATE_DIRS`, `$OPENCODE_PLAYWRIGHT_VERSION`); `check_version()` now **returns** (0 = needs download, 1 = up-to-date) instead of `exit 0`.

- [ ] **Step 1: Write the failing test**

Create `/Users/andrew/code/replopencode/scratch-test-prepopulate.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# A fake binary so --binary skips network download; prints the fork banner.
fake=$(mktemp); printf '#!/bin/sh\necho "Replopencode v1.17.9-1"\n' > "$fake"; chmod +x "$fake"

tmp=$(mktemp -d)
existing="$tmp/exists/opencode"   # will exist -> should be prepopulated
mkdir -p "$existing"
absent="$tmp/absent/opencode"     # will NOT exist -> must be skipped

export HOME="$tmp/home"; mkdir -p "$HOME"
OPENCODE_PREPOPULATE_DIRS="$existing $absent" \
  bash install --binary "$fake" --version 1.17.9-1 --no-modify-path >/dev/null

test -d "$existing/node_modules/@opencode-ai/plugin" || { echo "FAIL: plugin not installed in existing dir"; exit 1; }
test ! -e "$absent" || { echo "FAIL: absent dir was created"; exit 1; }
grep -q '"@opencode-ai/plugin@1.17.9": "1.17.9"' "$existing/package-lock.json" || { echo "FAIL: lockfile root key not patched"; exit 1; }
test ! -d "$existing/node_modules/playwright" || { echo "FAIL: playwright installed without OPENCODE_PLAYWRIGHT_VERSION"; exit 1; }
echo "PASS"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scratch-test-prepopulate.sh`
Expected: FAIL — `install` does not yet prepopulate (no `node_modules/@opencode-ai/plugin`).

- [ ] **Step 3: Add the prepopulate constants and functions**

Near the top, right after `INSTALL_DIR=$HOME/.opencode/bin` / `mkdir -p "$INSTALL_DIR"` (~line 64), add:

```bash
# Replo dependency prepopulation. The config dirs are fixed in production;
# OPENCODE_PREPOPULATE_DIRS is a test-only override defaulting to that set.
# Only dirs that already exist are touched, so the human curl|bash path is a
# no-op (these absolute paths never exist on a personal machine).
PREPOPULATE_DIRS=${OPENCODE_PREPOPULATE_DIRS:-"/root/.config/opencode /workspace/.opencode /root/.opencode"}
PLAYWRIGHT_PRIMARY_DIR="/root/.config/opencode"
```

Add these functions just above the `if [ -n "$binary_path" ]; then` main install block (~line 354):

```bash
npm_install_exact() {
    local dir="$1"; shift
    ( cd "$dir" && npm install --silent --save-exact --package-lock=true \
        --workspaces=false --no-audit --no-fund --no-progress --omit=optional "$@" )
}

patch_plugin_lockfile() {
    local dir="$1" spec="$2" base="$3"
    node -e '
      const fs = require("fs");
      const [dir, spec, base] = process.argv.slice(1);
      const p = dir + "/package-lock.json";
      if (!fs.existsSync(p)) { console.error("FATAL: no package-lock.json in " + dir); process.exit(1); }
      const l = JSON.parse(fs.readFileSync(p, "utf8"));
      l.packages ??= {}; l.packages[""] ??= {}; l.packages[""].dependencies ??= {};
      l.packages[""].dependencies[spec] = base;
      fs.writeFileSync(p, JSON.stringify(l, null, 2) + "\n");
    ' "$dir" "$spec" "$base"
}

prepopulate_deps() {
    # No usable version (e.g. a bare --binary dev install) -> nothing to pin.
    if [ -z "$specific_version" ] || [ "$specific_version" = "local" ]; then
        return 0
    fi
    local base="${specific_version%%-*}"
    local plugin_spec="@opencode-ai/plugin@${base}"
    local touched=false
    for dir in $PREPOPULATE_DIRS; do
        [ -d "$dir" ] || continue
        touched=true
        print_message info "${MUTED}Prepopulating ${NC}${plugin_spec}${MUTED} in ${NC}${dir}"
        [ -f "$dir/package.json" ] || printf '{\n  "private": true\n}\n' > "$dir/package.json"

        if ! npm_install_exact "$dir" "$plugin_spec"; then
            print_message error "FATAL: npm install ${plugin_spec} failed in ${dir}"; exit 1
        fi
        [ -d "$dir/node_modules/@opencode-ai/plugin" ] || {
            print_message error "FATAL: @opencode-ai/plugin not installed in ${dir}"; exit 1; }

        if [ "$dir" = "$PLAYWRIGHT_PRIMARY_DIR" ] && [ -n "${OPENCODE_PLAYWRIGHT_VERSION:-}" ]; then
            local pw_spec="playwright@${OPENCODE_PLAYWRIGHT_VERSION}"
            print_message info "${MUTED}Prepopulating ${NC}${pw_spec}${MUTED} in ${NC}${dir}"
            if ! npm_install_exact "$dir" "$pw_spec"; then
                print_message error "FATAL: npm install ${pw_spec} failed in ${dir}"; exit 1
            fi
            [ -d "$dir/node_modules/playwright" ] || {
                print_message error "FATAL: playwright not installed in ${dir}"; exit 1; }
            ( cd "$dir" && node --input-type=module -e "await import('playwright')" ) || {
                print_message error "FATAL: playwright not importable in ${dir}"; exit 1; }
        fi

        patch_plugin_lockfile "$dir" "$plugin_spec" "$base"
    done
    [ "$touched" = true ] && print_message info "${MUTED}Dependency prepopulation complete${NC}"
    return 0
}
```

- [ ] **Step 4: Make `--binary` keep the requested version, refactor `check_version`, and call `prepopulate_deps`**

In the `--binary` branch, change `specific_version="local"` (~line 73 region inside the early `if [ -n "$binary_path" ]` block that sets `specific_version`) to:

```bash
    specific_version="${requested_version:-local}"
```

Replace `check_version()` (~line 221-235) with a returning version:

```bash
check_version() {
    if command -v opencode >/dev/null 2>&1; then
        installed_version=$(opencode --version 2>/dev/null || echo "")
        if [[ "$installed_version" == "$specific_version" ]]; then
            print_message info "${MUTED}Version ${NC}$specific_version${MUTED} already installed${NC}"
            return 1
        fi
        print_message info "${MUTED}Installed version: ${NC}$installed_version."
    fi
    return 0
}
```

Replace the main install block (~line 354-359):

```bash
if [ -n "$binary_path" ]; then
    install_from_binary
else
    if check_version; then
        download_and_install
    fi
fi

prepopulate_deps
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bash scratch-test-prepopulate.sh`
Expected: `PASS` (plugin installed in the existing dir, absent dir untouched, lockfile root key patched, no playwright).

- [ ] **Step 6: Verify the human path is still binary-only**

Run:
```bash
rm -rf /tmp/oc-human && HOME=/tmp/oc-human bash install --binary "$(mktemp)" --version 1.17.9-1 --no-modify-path 2>/dev/null; \
find /tmp/oc-human -path '*node_modules/@opencode-ai/plugin*' | head -1
```
Expected: no output (no Replo config dirs exist under the fake HOME, so prepopulate is a no-op). (The temp file passed to `--binary` just stands in for a binary; we only assert no prepopulation happened.)

- [ ] **Step 7: Commit**

```bash
rm -f scratch-test-prepopulate.sh
git add install
git commit -m "feat(install): auto-detect prepopulate of @opencode-ai/plugin

Derive the plugin base version from the requested version and npm-install
@opencode-ai/plugin into whichever fixed Replo config dirs exist. Playwright
stays opt-in via OPENCODE_PLAYWRIGHT_VERSION (build-time only). check_version
now returns instead of exiting so prepopulate always runs.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `install` — SHA256 checksum verification (fork repo)

**Files:**
- Modify: `/Users/andrew/code/replopencode/install` (URL block ~line 183-204; `download_and_install` ~line 327-346; add `verify_checksum` function)
- Test: `/Users/andrew/code/replopencode/scratch-test-checksum.sh` (throwaway)

**Interfaces:**
- Consumes: `$url`, `$filename`, `$specific_version`, `$requested_version`.
- Produces: `$sums_url` (set alongside `$url`); `verify_checksum <file> <name> <sums_url>` (aborts on mismatch/missing).

- [ ] **Step 1: Write the failing test**

Create `/Users/andrew/code/replopencode/scratch-test-checksum.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

# Source only the verify_checksum function out of install, with stubs.
src() {
  print_message() { shift; echo "$@"; }
  MUTED=""; NC=""; RED=""
  # shellcheck disable=SC1090
  source <(sed -n '/^verify_checksum() {/,/^}/p' install)
}

work=$(mktemp -d)
echo "payload" > "$work/opencode-linux-x64.tar.gz"
sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi; }
( cd "$work" && sum opencode-linux-x64.tar.gz > SHA256SUMS )

# happy path (file:// sums url)
( src; verify_checksum "$work/opencode-linux-x64.tar.gz" "opencode-linux-x64.tar.gz" "file://$work/SHA256SUMS" ) \
  && echo "PASS-good" || { echo "FAIL-good"; exit 1; }

# tampered archive must abort (subshell so exit doesn't kill us)
echo "tampered" > "$work/opencode-linux-x64.tar.gz"
( src; verify_checksum "$work/opencode-linux-x64.tar.gz" "opencode-linux-x64.tar.gz" "file://$work/SHA256SUMS" ) 2>/dev/null \
  && { echo "FAIL-tamper (did not abort)"; exit 1; } || echo "PASS-tamper"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scratch-test-checksum.sh`
Expected: FAIL — `verify_checksum` does not exist yet, so `sed` extracts nothing and the call errors (no `PASS-good`).

- [ ] **Step 3: Set `$sums_url` alongside `$url`**

In the version/URL block (~line 183-204), add a `sums_url` in each branch:

In the `if [ -z "$requested_version" ]` branch, after `url="...releases/latest/download/$filename"`:
```bash
        sums_url="https://github.com/replohq/replopencode/releases/latest/download/SHA256SUMS"
```
In the `else` branch, after `url="...releases/download/v${requested_version}/$filename"`:
```bash
        sums_url="https://github.com/replohq/replopencode/releases/download/v${requested_version}/SHA256SUMS"
```

- [ ] **Step 4: Add `verify_checksum` and call it before extract**

Add this function just above `download_and_install()` (~line 327):

```bash
verify_checksum() {
    local file="$1" name="$2" sums_url="$3"
    local sums="${file}.SHA256SUMS"
    if ! curl -fsSL -o "$sums" "$sums_url"; then
        print_message error "${RED}Error: failed to download SHA256SUMS from ${sums_url}${NC}"; exit 1
    fi
    # SHA256SUMS lines are "<hash>  <name>" or "<hash> *<name>".
    local expected
    expected=$(awk -v f="$name" '($2==f)||($2=="*"f){print $1; exit}' "$sums")
    if [ -z "$expected" ]; then
        print_message error "${RED}Error: no checksum for ${name} in SHA256SUMS${NC}"; exit 1
    fi
    local actual
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$file" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
        actual=$(shasum -a 256 "$file" | awk '{print $1}')
    else
        print_message error "${RED}Error: neither sha256sum nor shasum is available${NC}"; exit 1
    fi
    if [ "$expected" != "$actual" ]; then
        print_message error "${RED}Error: checksum mismatch for ${name}${NC}"
        print_message error "  expected: ${expected}"
        print_message error "  actual:   ${actual}"
        exit 1
    fi
    print_message info "${MUTED}Checksum verified for ${NC}${name}"
}
```

In `download_and_install()`, add the verify call **after the download, before extract** — i.e. between the download `if/fi` block (ends ~line 335) and `if [ "$os" = "linux" ]; then tar ...` (~line 337):

```bash
    verify_checksum "$tmp_dir/$filename" "$filename" "$sums_url"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bash scratch-test-checksum.sh`
Expected: `PASS-good` then `PASS-tamper`.

- [ ] **Step 6: Commit**

```bash
rm -f scratch-test-checksum.sh
git add install
git commit -m "feat(install): verify archive against SHA256SUMS before extract

Tag-pinning fixes which release; this fixes the bytes. Aborts on missing or
mismatched checksum. --binary local installs are exempt.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Release flow — emit SHA256SUMS, update runbook, cut staging prerelease (fork repo)

**Files:**
- Modify: `~/.claude/skills/release-opencode/SKILL.md` (archive step, release step, critical rules)
- No repo code file; the deliverable is a documented+exercised release flow and a working staging prerelease.

**Interfaces:**
- Produces: a prerelease `v<base>-<N>-rc.1` carrying all archives **+ `SHA256SUMS`** and the updated `install`, used by the Task-4 checkpoint.

- [ ] **Step 1: Add SHA256SUMS generation to the runbook's Archive step**

In `SKILL.md`, in the **Archive** step, after the per-target archive loop, add:

````markdown
Then generate a single checksum manifest over every archive (the install
script verifies the downloaded archive against this before extracting):
```bash
cd packages/opencode/dist
# macOS: shasum; linux: sha256sum. Names must be bare (no path) to match $filename.
( shasum -a 256 *.tar.gz *.zip 2>/dev/null || sha256sum *.tar.gz *.zip ) > SHA256SUMS
cat SHA256SUMS
```
````

- [ ] **Step 2: Add SHA256SUMS to the release upload + document the version model**

In `SKILL.md`, change the `gh release create` / `gh release upload` examples to include `SHA256SUMS`:
```bash
gh release create v<v> --repo replohq/replopencode --target dev --latest \
  --title "Replopencode v<v>" --notes "..." \
  packages/opencode/dist/*.tar.gz packages/opencode/dist/*.zip \
  packages/opencode/dist/SHA256SUMS
```
Add a short subsection documenting: version format `<base>-<N>`; the plugin version is derived (`${v%%-*}`) by `install`, so `OPENCODE_PLUGIN_NPM_VERSION` is gone; bumping opencode = set the version in exactly two files (`entries.ts` curlInstall `version` + Dockerfile `REPLO_OPENCODE_VERSION`); `install` now prepopulates `@opencode-ai/plugin` into existing config dirs and (build-only) playwright via `OPENCODE_PLAYWRIGHT_VERSION`.

Add to the **Critical rules** table:
```markdown
| **Every release must publish `SHA256SUMS`** | `install` verifies the downloaded archive against it before extract; a release without it makes every install abort. |
```

- [ ] **Step 3: Build the targets off this branch**

Run from the fork repo on `feat/versioned-opencode-packaging`:
```bash
OPENCODE_VERSION=1.17.9-1-rc.1 \
OPENCODE_TARGETS="opencode-linux-x64,opencode-linux-x64-baseline,opencode-linux-arm64,opencode-darwin-arm64" \
  bun run --cwd packages/opencode build --skip-embed-web-ui
```
Expected: builds complete; the darwin smoke test prints `Replopencode v1.17.9-1-rc.1`.

- [ ] **Step 4: Archive + generate SHA256SUMS**

```bash
cd packages/opencode/dist
for t in opencode-linux-x64 opencode-linux-x64-baseline opencode-linux-arm64; do ( cd "$t/bin" && tar -czf "../../$t.tar.gz" * ); done
( cd opencode-darwin-arm64/bin && zip -qr ../../opencode-darwin-arm64.zip * )
( shasum -a 256 *.tar.gz *.zip 2>/dev/null || sha256sum *.tar.gz *.zip ) > SHA256SUMS
cat SHA256SUMS
cd -
```
Expected: `SHA256SUMS` lists one hash per archive.

- [ ] **Step 5: Cut the staging prerelease (pointed at this branch)**

```bash
gh release create v1.17.9-1-rc.1 --repo replohq/replopencode \
  --target feat/versioned-opencode-packaging --prerelease \
  --title "Replopencode v1.17.9-1-rc.1 (versioned packaging)" \
  packages/opencode/dist/*.tar.gz packages/opencode/dist/*.zip packages/opencode/dist/SHA256SUMS
```
Expected: prerelease created; assets include `SHA256SUMS`; not marked latest.

- [ ] **Step 6: Verify checksum end-to-end on the dev machine (binary-only path)**

```bash
rm -rf /tmp/oc-rc && HOME=/tmp/oc-rc bash install --version 1.17.9-1-rc.1 --no-modify-path
/tmp/oc-rc/.opencode/bin/opencode --version
```
Expected: log shows `Checksum verified for opencode-darwin-arm64.zip` (or your host archive); version prints `Replopencode v1.17.9-1-rc.1`; no Replo config dirs exist on the dev mac so no prepopulation runs.

- [ ] **Step 7: Commit the runbook changes**

```bash
git -C ~/.claude add skills/release-opencode/SKILL.md 2>/dev/null || true
# (If the personal skills dir is a git repo, commit there; otherwise the edit stands as-is.)
```
The fork repo has no code change in this task; the deliverable is the published prerelease + updated runbook.

---

## 🔱 Task 4: CHECKPOINT — install on a clean sandbox (gate)

**This is a hard gate. Do not start Tasks 5-7 until it passes.** It validates the two things that cannot be validated on the dev machine: auto-detect prepopulate into real config dirs, and **egress** (curl + npm through the sandbox proxy).

- [ ] **Step 1: Provision a clean sandbox** (a fresh Daytona sandbox / box that already has the three config dirs from the current snapshot).

- [ ] **Step 2: Run the prerelease install exactly as converge would**

On the sandbox:
```bash
curl -fsSL https://raw.githubusercontent.com/replohq/replopencode/v1.17.9-1-rc.1/install | VERSION=1.17.9-1-rc.1 bash
```

- [ ] **Step 3: Observe and record**

- `opencode --version` → `Replopencode v1.17.9-1-rc.1`.
- `@opencode-ai/plugin@1.17.9` present in each existing config dir:
  ```bash
  for d in /root/.config/opencode /workspace/.opencode /root/.opencode; do
    test -d "$d/node_modules/@opencode-ai/plugin" && echo "OK $d" || echo "MISSING $d"
  done
  ```
- playwright untouched (no `OPENCODE_PLAYWRIGHT_VERSION` was set):
  ```bash
  test -d /root/.config/opencode/node_modules/playwright && echo "playwright present (pre-existing/baked)" || echo "no playwright (expected if not baked)"
  ```
  (Key assertion: the converge install did **not** change playwright — compare against its pre-install state.)
- **Egress:** the `curl` and the `npm install` both succeeded (no proxy/allowlist failure). If they fail, the GitHub raw host and/or npm registry must be allowlisted on the sandbox egress proxy — **resolve before proceeding.**
- Checksum line printed during install.

- [ ] **Step 4: Decision** — if all pass, proceed. If egress fails, fix the allowlist and re-run. Record anything surprising in the spec's "Risks / open items".

---

## Task 5: Cut the stable release (fork repo)

Only after the checkpoint passes. This produces the real artifact the monorepo pins to.

- [ ] **Step 1: Merge `feat/versioned-opencode-packaging` to `dev`** (PR + merge per normal review).

- [ ] **Step 2: Build, archive, SHA256SUMS off `dev`** (repeat Task 3 steps 3-4 with `OPENCODE_VERSION=1.17.9-1`).

- [ ] **Step 3: Create the stable, latest release with checksums**

```bash
gh release create v1.17.9-1 --repo replohq/replopencode --target dev --latest \
  --title "Replopencode v1.17.9-1" --notes "Version-driven packaging: install now prepopulates @opencode-ai/plugin; SHA256SUMS published." \
  packages/opencode/dist/*.tar.gz packages/opencode/dist/*.zip packages/opencode/dist/SHA256SUMS
```
Expected: `v1.17.9-1` is latest; assets include `SHA256SUMS`; tag carries the updated `install`.

- [ ] **Step 4: Delete the staging prerelease** (the stable `--latest` shadows it):
```bash
gh release delete v1.17.9-1-rc.1 --repo replohq/replopencode --yes
git push origin :refs/tags/v1.17.9-1-rc.1
```

---

## Task 6: Converge entry in `entries.ts` (monorepo)

**Files:**
- Modify: `/Users/andrew/code/worktree-1/sandbox-packages/sandbox-upgrader/src/entries.ts`
- Test: `pnpm assemble` + the package's unit specs.

**Interfaces:**
- Consumes: `curlInstall({ name, version, probeCommand, probePattern, script, onChange })` from `entry-helpers.ts` (on `origin/main`).
- Produces: one `InstallEntry` for opencode in the exported entry list.

- [ ] **Step 1: Branch off `origin/main`**

```bash
cd /Users/andrew/code/worktree-1
git fetch origin --quiet
git checkout -b feat/opencode-curlinstall-entry origin/main
```
Confirm the helper exists: `grep -n "export function curlInstall" sandbox-packages/sandbox-upgrader/src/entry-helpers.ts`

- [ ] **Step 2: Add the opencode entry**

In `sandbox-packages/sandbox-upgrader/src/entries.ts`, import `curlInstall` from `./entry-helpers` (match the existing import style of other helpers in that file) and add to the entry list:

```ts
curlInstall({
  name: "opencode",
  version: "1.17.9-1",
  script:
    "curl -fsSL https://raw.githubusercontent.com/replohq/replopencode/v{version}/install | VERSION={version} bash",
  probeCommand: "opencode --version",
  probePattern: "Replopencode v(\\S+)",
  onChange: ["restart-opencode"],
}),
```
(No `OPENCODE_PLAYWRIGHT_VERSION` in the script → converge reconciles binary + plugin only. `probePattern` captures `1.17.9-1` from `Replopencode v1.17.9-1`, matching `version`.)

- [ ] **Step 3: Assemble to validate the entry resolves**

Run: `cd sandbox-packages/sandbox-upgrader && pnpm assemble`
Expected: assemble succeeds (the install entry is well-formed and `version` passes `assertShellSafe`). Verify `1.17.9-1` does not trip the shell-safety check (`.` and `-` are allowed).

- [ ] **Step 4: Run the package unit tests**

Run: `pnpm -C sandbox-packages/sandbox-upgrader test` (or the repo's configured command, e.g. `pnpm vitest run`).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sandbox-packages/sandbox-upgrader/src/entries.ts
git commit -m "feat(upgrader): converge opencode via version-driven curlInstall

Installs the fork binary + reconciles @opencode-ai/plugin via the tag-pinned
install script. Idle-aware restart-opencode on change. Playwright untouched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Dockerfile single install RUN + delete the mjs (monorepo)

**Files:**
- Modify: `/Users/andrew/code/worktree-1/apps/daytona-snapshot/Dockerfile` (ARGs ~line 103-104; install RUN ~line 149-151; the prepopulate RUN)
- Delete: `/Users/andrew/code/worktree-1/apps/daytona-snapshot/prepopulate-opencode-deps.mjs`
- Test: `docker build` of the snapshot stage.

**Interfaces:**
- Consumes: the published stable release `v1.17.9-1` carrying `install` + `SHA256SUMS`; `PLAYWRIGHT_VERSION` ARG.

- [ ] **Step 1: Drop the derived ARG**

Remove the `ARG OPENCODE_PLUGIN_NPM_VERSION=...` line (~line 104) and any later re-declaration. Keep `ARG REPLO_OPENCODE_VERSION=1.17.9-1` and `ARG PLAYWRIGHT_VERSION=...`. Update the comment block (~line 96-101) to state the plugin version is derived inside `install`.

- [ ] **Step 2: Collapse install + prepopulate into one RUN**

Replace the opencode install RUN (~line 149-151) with:

```dockerfile
# Install Replopencode (binary + @opencode-ai/plugin prepopulate, one version-driven step)
RUN mkdir -p /root/.config/opencode /workspace/.opencode /root/.opencode \
    && curl -fsSL https://raw.githubusercontent.com/replohq/replopencode/v${REPLO_OPENCODE_VERSION}/install -o /tmp/install-opencode.sh \
    && OPENCODE_PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION}" VERSION="${REPLO_OPENCODE_VERSION}" bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh
```
Then **delete** the separate `RUN node .../prepopulate-opencode-deps.mjs ...` line (and any `COPY` of that file).

Note: the three config dirs must exist before the install RUN so auto-detect prepopulates them. If a later stage's `COPY src/packages/replo-opencode-harness/.generated/opencode/ /root/.config/opencode/` currently precedes prepopulate, keep that ordering — the `mkdir -p` above is idempotent and harmless. Ensure the install RUN runs **after** the harness COPY so `/root/.config/opencode` holds the harness when plugin is added. Verify ordering against the current file.

- [ ] **Step 3: Delete the mjs**

```bash
git rm apps/daytona-snapshot/prepopulate-opencode-deps.mjs
```

- [ ] **Step 4: Build the snapshot stage**

Run the repo's snapshot build (e.g. `docker build` of `apps/daytona-snapshot` or the configured `Build snapshot` command). Use `--no-cache` for the install layer if the version is unchanged from a prior build.
Expected: build succeeds; binary + `@opencode-ai/plugin@1.17.9` in all three config dirs; playwright in `/root/.config/opencode`; the playwright `import` smoke test (now inside `install`) passes.

- [ ] **Step 5: Smoke-check the built image**

In a shell in the built image:
```bash
opencode --version   # Replopencode v1.17.9-1
for d in /root/.config/opencode /workspace/.opencode /root/.opencode; do test -d "$d/node_modules/@opencode-ai/plugin" && echo "OK $d"; done
test -d /root/.config/opencode/node_modules/playwright && echo "OK playwright"
```
Expected: all OK.

- [ ] **Step 6: Commit**

```bash
git add apps/daytona-snapshot/Dockerfile
git commit -m "feat(daytona): single version-driven opencode install; drop prepopulate mjs

One RUN installs the fork binary and prepopulates @opencode-ai/plugin (version
derived from REPLO_OPENCODE_VERSION) + build-time playwright. Removes the
OPENCODE_PLUGIN_NPM_VERSION ARG and prepopulate-opencode-deps.mjs.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review notes

- **Spec coverage:** versioning model → Global Constraints + Task 1 base derivation; install single-authority (checksum + auto-detect prepopulate + playwright env + check_version) → Tasks 1-2; Dockerfile single RUN + drop ARG + delete mjs → Task 7; converge entry → Task 6; release flow + SHA256SUMS → Tasks 3,5; clean-sandbox checkpoint + egress → Task 4; tamper test → Task 2 Step 1; human-path-unchanged → Task 1 Step 6.
- **Out-of-scope honored:** no content-addressed binary/node_modules; playwright independent + build-only; no node_modules pruning.
- **Type/name consistency:** `curlInstall` fields (`name`, `version`, `probeCommand`, `probePattern` (string), `script`, `onChange`) match `entry-helpers.ts`; `prepopulate_deps`/`verify_checksum`/`check_version` names consistent across steps.
- **Known judgement calls left to implementer:** exact import line style in `entries.ts`; exact snapshot build command; whether the personal skill dir is under git.
