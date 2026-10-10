# ZTC releases

Public distribution policy for the self-contained Apple Silicon ZTC desktop.
The application is `ztc.app`, displayed as **ZTC**; its signing identifier remains
`dev.zerg.zterm`. It owns Node 22.23.2 and the exact published `@zergai/ztc` package.
It shares `~/.ztc` with the npm CLI. It does not require a global Node installation.

This repository is being bootstrapped. **No verified ZTC release has been
activated yet.** The existing `Epoch-ML/zterm-releases` repository and its feeds
remain unchanged. Existing ZTerm installations keep using their existing feed;
install the new ZTC app beside them to adopt this distribution.

## Release order and trust

1. Merge and qualify the source in `Epoch-ML/zerg`; publish its npm beta through
   the existing protected OIDC allocator workflow. Do not bypass the allocator.
2. Create the matching source `ztc-desktop-preview-v<version>` tag at the exact
   npm package `zergRelease.sourceCommit`. The source workflow emits a canonical
   request containing source SHA and the npm registry's exact SHA-512 integrity.
3. Add only those unchanged request bytes in a reviewed one-file PR here. Merge
   to protected `main`; create the matching public tag at the request's unique
   addition commit. Never move or replace a published tag.
4. Dispatch the release workflow. A read-only source key fetches that exact tag;
   build/test/audit run without signing credentials. Node is downloaded from
   nodejs.org at a fixed SHA-256; the npm artifact and source lock must agree.
5. A fresh Apple signer validates every file before importing credentials. All
   native binaries are Developer ID signed; only Node receives its JIT entitlement.
   Both preview and stable apps and DMGs must be notarized, stapled and assessed.
6. An isolated updater signer signs the archive and public catalog with the
   selected channel key. The publisher re-downloads all eight immutable assets,
   rechecks provenance, signatures, hashes, archive bounds and Mach-O architecture.
7. Generate the exact Homebrew formula from the verified `release.json`, push it
   to `Epoch-ML/homebrew-tap`, and qualify installation on clean Apple Silicon macOS.
   Qualify npm/bun with the exact published version and curl from the served script.
8. **Activate the channel last.** Feed promotion refuses unless the canonical
   installer at `https://zergai.com/install/ztc.sh` matches this repo byte-for-byte
   and the tap formula matches the verified catalog. `release.json` appears only
   with the final monotonic feed update. The website may then expose install methods.

The first npm release is a beta: use the **preview** desktop channel and
`curl -fsSL https://zergai.com/install/ztc.sh | sh -s -- --preview`.
Stable publication refuses any prerelease desktop or npm version.

Public channels will be:

- `https://epoch-ml.github.io/ztc-releases/preview/release.json`
- `https://epoch-ml.github.io/ztc-releases/stable/release.json`

Each also contains `latest.json` for the native updater. URLs are exact immutable
GitHub Release paths in this repository; no external artifact hosts are accepted.

## Credentials and approvals

Empty main-only environments have been created. Apple and both updater signers
require approval from `idanbeck`, and administrator bypass is disabled. Secret
values were not copied from the legacy repository and cannot be exported by GitHub.
No repository-wide secrets are needed or permitted by this split-trust design.

| Environment | Required secrets |
| --- | --- |
| `zterm-source` | `ZERG_SOURCE_DEPLOY_KEY` (read-only deploy key for `Epoch-ML/zerg`) |
| `zterm-apple-stable` | `ZTERM_APPLE_CERTIFICATE`, `ZTERM_APPLE_CERTIFICATE_PASSWORD`, `ZTERM_APPLE_SIGNING_IDENTITY`, `ZTERM_APPLE_API_ISSUER`, `ZTERM_APPLE_API_KEY_ID`, `ZTERM_APPLE_API_PRIVATE_KEY` |
| `zterm-updater-preview` | `ZTERM_PREVIEW_UPDATE_SIGNING_PRIVATE_KEY`, `ZTERM_PREVIEW_UPDATE_SIGNING_PRIVATE_KEY_PASSWORD` |
| `zterm-updater-stable` | `ZTERM_STABLE_UPDATE_SIGNING_PRIVATE_KEY`, `ZTERM_STABLE_UPDATE_SIGNING_PRIVATE_KEY_PASSWORD` |
| `zterm-feed` | `ZTERM_FEED_DEPLOY_KEY` (write deploy key restricted by branch rules to `release-data`) |
| `github-pages` | No secrets; Actions OIDC deployment permissions only |

The committed channel public keys are unchanged from the legacy distribution.
Provision matching private keys in these isolated environments, or rotate both
new public keys and source-embedded keys in a reviewed change before first release.
Never reuse a channel key as an Apple identity or source key.

Before first dispatch, protect `main` and `ztc-desktop-*` tags, allow only reviewed
changes, restrict the feed deploy key to `release-data`, and configure GitHub Pages
for Actions. The `release-data` branch is initialized from the landing page by the first
verified activation; there is no placeholder release manifest.

## Local checks

```sh
npm ci --ignore-scripts
npm test
npm run test:mutation
actionlint .github/workflows/release.yml
npm audit --audit-level=moderate
```

Clean-machine launch, CLI version, desktop login, resume and signed update are
release gates. A prepared candidate or a green source build alone is not evidence
that a public download is ready. Never publish synthetic hashes or unsigned assets.

## Activate a verified bridge release

The additive `activate.yml` workflow supports releases signed by the
[legacy signing bridge](https://github.com/Epoch-ML/zterm-releases/blob/main/.github/workflows/ztc-bridge.yml)
without copying its secrets. It never builds, signs, creates, uploads, or edits a
GitHub Release. An authorized operator must first verify the bridge run and
publish the eight canonical assets as an immutable release here, at the exact
reviewed request tag. Drafts, mutable releases, wrong provenance, missing assets,
invalid signatures and changed release tags are rejected.

After the matching installer and Homebrew formula are deployed and clean-machine
qualification is complete, dispatch activation from this repository's protected
`main`:

```sh
gh workflow run activate.yml --repo Epoch-ML/ztc-releases --ref main \
  -f channel=preview -f version=0.5.0-beta.1 \
  -f source_sha=639a0d0cc4d6e3eed77db19d937862ab82a36f22
```

Activation re-downloads all eight immutable assets over HTTPS and applies the
same request, asset, signature, bounded archive, bundle, installer, Homebrew and
monotonic feed checks as `release.yml`. Only its feed job has repository write
permission, through the short-lived `GITHUB_TOKEN`; it has no signing credentials.
The first successful activation creates `release-data` from the static site only.
Later activations retain its existing history. An unavailable remote is an error,
not permission to reset a feed. Pages deploys through Actions OIDC, then compares
the live updater manifest, version metadata, public catalog and catalog signature
with the verified bytes.

The existing full release workflow remains available and unchanged. Neither path
may be dispatched before the npm artifact and reviewed immutable request/tag are
ready. A prepared workflow does not mean a download is active.
