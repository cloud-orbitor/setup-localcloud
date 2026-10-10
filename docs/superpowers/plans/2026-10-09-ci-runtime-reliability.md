# CI Runtime Reliability Implementation Plan

> Checkboxes record completed implementation and verification; publication gates are listed below.

**Goal:** Address issues #1–#7 with one tested, reviewable action change.

**Architecture:** Keep the zero-dependency JavaScript action and use the runtime's catalog and SDK environment. Separate immutable image acquisition from runtime ownership, and attach MCP directly to the existing gateway. Put publishing and qualification in explicit workflows.

**Tech Stack:** Node 24, Docker, optional Skopeo OCI transport, Python Google SDKs, native MCP JSON-RPC, GitHub Actions.

**Spec:** `docs/ci-runtime-contract.md`; [issue backlog](https://github.com/cloud-orbitor/setup-localcloud/issues).

## Global Constraints

- Node `>=24`; no production npm dependencies.
- Immutable `@sha256` image references; default services `gcs,pubsub,bigquery`; 4 GiB owned-runtime memory limit.
- No CLI worktree changes, global MCP settings, application-data caches or published tag changes.
- Socket access requires explicit opt-in; existing-runtime ownership stays external.
- Public claims require matching image/platform/SDK evidence; a passing readiness check is not workload execution.

---

### Task 1: Immutable image reuse and optional verified cache (#6, #7)

**Files:** Modify `src/runtime.mjs`, `action.yml`, `test/runtime.test.mjs`; create `src/image-cache.mjs`, `scripts/image-cache.mjs`, `test/image-cache.test.mjs`.

**Interfaces:** `acquireImage(config, command)` produces a validated image inspection and runtime image reference. `verifyOCI(directory, image, platform)` produces the selected configuration digest after checking root, platform manifest, config and layer hashes. Existing `startRuntime` consumes acquisition before Docker creation.

- [x] Write assertions for warm reuse, one cold pull, wrong platform, daemon failure, quota/auth diagnostics, corrupt OCI blobs and a tampered platform descriptor.

```js
assert.equal(calls.filter(args => args[0] === 'pull').length, 0);
assert.throws(() => verifyOCI(cache, image, {os: 'linux', architecture: 'amd64'}), /digest|platform/);
```

- [x] Run `node --test test/runtime.test.mjs test/image-cache.test.mjs` and retain the passing result. The planned preimplementation red-run record was not retained.
- [x] Inspect the exact requested image first; catch only Docker's image-missing error. Validate Docker-server OS/architecture; retain digest pinning. Reject daemon errors and wrong-platform images before creating resources.
- [x] Implement opt-in OCI restoration. Verify SHA-256 descriptors using bounded buffers, require the selected manifest to belong to the pinned root, and inspect the loaded configuration digest before running it. Use Skopeo only for this optional path.
- [x] Run the tests and a real warm Docker startup with pull calls forbidden. Measure optional cache preparation/restoration separately from SDK readiness.
- [x] Commit this task and obtain independent review before proceeding.

### Task 2: Runtime catalog, networking, execution ownership and MCP (#1–#4)

**Files:** Modify `src/runtime.mjs`, `action.yml`, `test/runtime.test.mjs`; create `src/mcp-stdio.mjs`, `test/mcp.test.mjs`, `scripts/qualify.mjs`.

**Interfaces:** `configure(config, runtime)` validates `/services`, readiness, project and `/env`. `environment(payload, runtime)` rewrites validated canonical endpoints using explicit mappings. `cleanup(record, command)` verifies the root and any execution network/volume ownership. MCP configuration passes the same URL, ports and project to a stdio bridge.

- [x] Add tests for remapped gateways, service-host networking, unsupported and unknown services before project writes, missing dependencies, immutable Docker ownership, existing-runtime preservation and MCP protocol forwarding.

```js
assert.equal(environment({GOOGLE_CLOUD_PROJECT:'ci-project', PUBSUB_EMULATOR_HOST:'localhost:5383'},
  {url:'http://localcloud:5380', ports:{}, record:null}).PUBSUB_EMULATOR_HOST, 'localcloud:5383');
assert.equal(projectWrites, 0);
```

- [x] Read runtime catalog fields dynamically. Fail on unknown/unsupported selections or unavailable required dependencies with their remediation steps. Do not introduce a fixed service registry.
- [x] Add `port-map`, `docker-access`, and `mcp` inputs. Create uniquely labelled execution resources only when needed. Capture ownership before resource creation; remove only verified owned children and resources during cleanup.
- [x] Generate job-local SDK environment and MCP files. Forward MCP requests to `/mcp` with the selected project; preserve errors/notifications and rewrite canonical endpoint strings to published ports. Keep writes and destructive operations disabled.
- [x] Run all Node tests, actual SDK write/readback, an SDK consumer in a container, a headless MCP client, and execution profiles against the pinned image. Record runtime prerequisites or product defects rather than treating readiness as execution proof.
- [x] Commit and obtain independent review; resolve important findings.

### Task 3: Hosted verification, distribution and consistent documentation (#1–#7)

**Files:** Modify `.github/workflows/qualify.yml`, cleanup verification, `README.md`, `docs/github-actions.md`, `docs/release-evidence.md`; create `.github/workflows/mirror.yml`, `docs/release-notes.md`, and an issue-resolution evidence table. Update the website guide in its existing PR branch.

**Interfaces:** Workflows consume action inputs/outputs and the qualification scripts. Documentation references the published release separately from candidate-only behavior. Mirror workflow consumes the pinned source digest, preserves all manifests and verifies the destination digest.

- [x] Parse every workflow and verify declared inputs/outputs against `action.yml`.

```bash
node --test
git diff --check
```

- [x] Add SDK/network/MCP/execution and cache qualification routes; use explicit selected services. Configure trusted cache production and fork-safe consumption; native service authentication remains pre-step configuration.
- [x] Prepare GHCR distribution with `skopeo copy --all --preserve-digests`. Preserve the current default and document the remaining publication/anonymous-pull verification gate and observed hosted quota behavior.
- [x] Update the website's canonical guide and generated repository copy; run Node 24.21.0/pnpm 12.9.1 serial production build, then installer verification and `graft build`.
- [x] Record exact action SHA/image/platform, passing and blocked tests, and residual requirements for every issue. Prepare consolidated release notes without publishing.
- [x] Obtain final independent review, push the local branch using only `cloud-orbitor`, create and attach a PR, and link evidence to all seven issues. Leave issues with unmet runtime/external acceptance criteria open.

## Execution status

All three action implementation tasks are complete and independently source-reviewed. [PR #8](https://github.com/cloud-orbitor/setup-localcloud/pull/8) contains the branch, plan and evidence; all seven issues link to it and remain open where acceptance is still unmet.

Thirty Node tests pass. Local SDK/MCP/container/catalog checks pass; Cloud Run and GKE native execution pass. [Hosted run 38008244866](https://github.com/cloud-orbitor/setup-localcloud/actions/runs/38008244866) passes every enabled job, including cold OCI cache preparation and a separate fresh AMD64 runner's restore/SDK/cleanup with registry pull calls forbidden. Website production build and installer checks pass; the guide is in [site PR #5](https://github.com/LocalGCloud/LocalGCloud.github.io/pull/5).

Dataproc's companion runtime fix passes eight service tests and native Spark/SDK deletion/cleanup in a locally derived image. The published runtime still needs that correction; cloud-orbitor cannot access its private repository. Mirror publication and anonymous verification await the owner's decision. Remote ARM64 cache transport is unqualified. No new action/image release or tag movement occurred.

The final source review found no remaining findings and reran the 30 Node tests. Temporary owned probe resources were removed. The original CLI and runtime checkouts' unrelated changes were preserved.
