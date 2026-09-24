# Releasing this fork

This is Replo's fork of opencode. It ships the same way upstream does — a
self-contained binary that a `curl | bash` install script downloads from GitHub
Releases, not via npm. The root `install` script points at `replohq/replopencode`
releases instead of `anomalyco/opencode`.

**There is no CI release path.** The inherited `.github/workflows/publish.yml` is
gated `if: github.repository == 'anomalyco/opencode'` and never fires here. Every
release is built locally and uploaded by hand — don't go looking for a
`workflow_dispatch` to trigger.

## Tags

Tags are `vX.Y.Z-N`. The base `X.Y.Z` is the upstream version this fork is built
on; `-N` is our patch number on that base, 1-indexed. A new fork change on the
same base bumps `-N`. Re-applying the fork onto a new upstream base resets it to
`-1`.

## Cut a release

From `dev`, after merging your change. The `OPENCODE_TARGETS` filter keeps you
from cross-compiling all 12 targets — the Windows and musl cross-builds from
macOS are flaky, and Replo doesn't consume them.

```bash
OPENCODE_VERSION=<v> \
OPENCODE_TARGETS="opencode-linux-x64,opencode-linux-x64-baseline,opencode-linux-arm64,opencode-darwin-arm64" \
  bun run --cwd packages/opencode build --skip-embed-web-ui

# The SDK ships with the binary it was generated from. A stale tsbuildinfo makes tsc skip emitting dist.
rm -f packages/sdk/js/tsconfig.tsbuildinfo
bun ./packages/sdk/js/script/build.ts
git status --short packages/sdk   # must be empty: the committed SDK matches the server

( cd packages/opencode/dist
  for t in opencode-linux-x64 opencode-linux-x64-baseline opencode-linux-arm64; do
    ( cd "$t/bin" && tar -czf "../../$t.tar.gz" * ); done
  ( cd opencode-darwin-arm64/bin && zip -qr ../../opencode-darwin-arm64.zip * )
  ( shasum -a 256 *.tar.gz *.zip 2>/dev/null || sha256sum *.tar.gz *.zip ) > SHA256SUMS )

# Pack the SDK the way packages/sdk/js/script/publish.ts does, minus `npm publish`.
( cd packages/sdk/js
  jq --arg v "<v>" '.version = $v | .exports |= with_entries(.value |= (sub("^\\./src/"; "./dist/") | sub("\\.ts$"; "") | {types: (. + ".d.ts"), import: (. + ".js")}))' \
    package.json > package.json.release && mv package.json.release package.json
  bun pm pack   # writes opencode-ai-sdk-<v>.tgz and resolves catalog: versions
  git checkout -- package.json )

gh release create v<v> --repo replohq/replopencode --target dev --latest \
  --title "Replopencode v<v>" --notes "..." \
  packages/opencode/dist/*.tar.gz packages/opencode/dist/*.zip \
  packages/opencode/dist/SHA256SUMS \
  packages/sdk/js/opencode-ai-sdk-<v>.tgz
```

Archive names must be `opencode-<target>.<ext>` — the install script builds that
name to fetch. Linux targets are `.tar.gz`, darwin and windows are `.zip`, both
archived from `<target>/bin`. The SDK tarball must be named
`opencode-ai-sdk-<v>.tgz`, which is what `bun pm pack` writes; Replo installs it
by that name.

## Rules that bite

- **Always include `-N`.** `install` rejects a bare base (`1.17.9`) and rejects a
  `-N` whose tag isn't released yet, rather than guessing. Both failures surface
  downstream, where they fail a build instead of installing a wrong binary.
- **Every release must publish `SHA256SUMS`.** Since v1.17.9-1, `install`
  verifies the downloaded archive against it before extracting. A release without
  it makes every install abort.
- **Always build `opencode-linux-x64-baseline`.** `install` picks the baseline
  binary when the host CPU lacks AVX2; if it's missing, that install 404s.
- **Never re-point or delete a shipped tag.** Consumers fetch
  `…/replopencode/v<version>/install` _by tag_, so retagging silently changes what
  already-deployed machines install for a version they already pinned.
- **An installer fix reaches consumers only through a new release.** Pushing to
  `dev` updates the human convenience path and nothing else.
- **Ship glibc, not musl,** unless you're deliberately targeting Alpine.
- **Every release must attach `opencode-ai-sdk-<v>.tgz`.** Replo's coordinator
  installs the SDK from the release, because npm's `@opencode-ai/sdk` is
  upstream's and never has fork-only routes. A release without it fails that
  SDK bump at `pnpm install`. Never `npm publish` it: the npm scope is upstream's.

## Downstream

Replo pins this fork in three places, all in the `replohq/andytown` repo, and all
three move in lockstep _after_ the release exists: the Daytona snapshot's
`ARG OPENCODE_VERSION`, the sandbox-upgrader's opencode `curlInstall` row —
which rolls the new version onto already-running machines, not just new ones —
and the coordinator's `@opencode-ai/sdk`, which points at the release's SDK
tarball. So a bad release reaches production without anyone rebuilding an image.

That half of the runbook, including how to stage a prerelease from an unmerged PR
without disturbing the stable line, lives in that repo's `release-opencode` skill
(`.agents/skills/agent-tooling/release-opencode.md`).
