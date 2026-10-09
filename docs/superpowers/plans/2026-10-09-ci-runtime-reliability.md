# CI Runtime Reliability Implementation Plan

> Steps use checkbox (`- [ ]`) syntax so an executor can track progress task by task.

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

- [ ] Write assertions for warm reuse, one cold pull, wrong platform, daemon failure, quota/auth diagnostics, corrupt OCI blobs and a tampered platform descriptor.

```js
assert.equal(calls.filter(args => args[0] === 'pull').length, 0);
assert.throws(() => verifyOCI(cache, image, {os: 'linux', architecture: 'amd64'}), /digest|platform/);
```

- [ ] Run `node --test test/runtime.test.mjs test/image-cache.test.mjs` before implementation and record the expected failures.
- [ ] Inspect the exact requested image first; catch only Docker's image-missing error. Validate Docker-server OS/architecture; retain digest pinning. Reject daemon errors and wrong-platform images before creating resources.
- [ ] Implement opt-in OCI restoration. Verify SHA-256 descriptors using bounded buffers, require the selected manifest to belong to the pinned root, and inspect the loaded configuration digest before running it. Use Skopeo only for this optional path.
- [ ] Run the tests and a real warm Docker startup with pull calls forbidden. Measure optional cache preparation/restoration separately from SDK readiness.
- [ ] Commit this task and obtain independent review before proceeding.

### Task 2: Runtime catalog, networking, execution ownership and MCP (#1–#4)

**Files:** Modify `src/runtime.mjs`, `action.yml`, `test/runtime.test.mjs`; create `src/mcp-stdio.mjs`, `test/mcp.test.mjs`, `scripts/qualify.mjs`.

**Interfaces:** `configure(config, runtime)` validates `/services`, readiness, project and `/env`. `environment(payload, runtime)` rewrites validated canonical endpoints using explicit mappings. `cleanup(record, command)` verifies the root and any execution network/volume ownership. MCP configuration passes the same URL, ports and project to a stdio bridge.

- [ ] Add tests for remapped gateways, service-host networking, unsupported and unknown services before project writes, missing dependencies, immutable Docker ownership, existing-runtime preservation and MCP protocol forwarding.

```js
assert.equal(environment({GOOGLE_CLOUD_PROJECT:'ci-project', PUBSUB_EMULATOR_HOST:'localhost:5383'},
  {url:'http://localcloud:5380', ports:{}, record:null}).PUBSUB_EMULATOR_HOST, 'localcloud:5383');
assert.equal(projectWrites, 0);
```

- [ ] Read runtime catalog fields dynamically. Fail on unknown/unsupported selections or unavailable required dependencies with their remediation steps. Do not introduce a fixed service registry.
- [ ] Add `port-map`, `docker-access`, and `mcp` inputs. Create uniquely labelled execution resources only when needed. Capture ownership before resource creation; remove only verified owned children and resources during cleanup.
- [ ] Generate job-local SDK environment and MCP files. Forward MCP requests to `/mcp` with the selected project; preserve errors/notifications and rewrite canonical endpoint strings to published ports. Keep writes and destructive operations disabled.
- [ ] Run all Node tests, actual SDK write/readback, an SDK consumer in a container, a headless MCP client, and execution profiles against the pinned image. Record runtime prerequisites or product defects rather than treating readiness as execution proof.
- [ ] Commit and obtain independent review; resolve important findings.

### Task 3: Hosted verification, distribution and consistent documentation (#1–#7)

**Files:** Modify `.github/workflows/qualify.yml`, cleanup verification, `README.md`, `docs/github-actions.md`, `docs/release-evidence.md`; create `.github/workflows/mirror.yml`, `docs/release-notes.md`, and an issue-resolution evidence table. Update the website guide in its existing PR branch.

**Interfaces:** Workflows consume action inputs/outputs and the qualification scripts. Documentation references the published release separately from candidate-only behavior. Mirror workflow consumes the pinned source digest, preserves all manifests and verifies the destination digest.

- [ ] Parse every workflow and verify declared inputs/outputs against `action.yml`.

```bash
node --test
git diff --check
```

- [ ] Add SDK/network/MCP/execution and cache qualification routes; use explicit selected services. Configure trusted cache production and fork-safe consumption; native service authentication remains pre-step configuration.
- [ ] Prepare GHCR distribution with `skopeo copy --all --preserve-digests`. Do not switch the default to an unverified or unpublished mirror. Record anonymous/authenticated pull results and unresolved hosted-exemption behavior.
- [ ] Update the website's canonical guide and generated repository copy; run Node 24.21.0/pnpm 12.9.1 serial production build, then installer verification and `graft build`.
- [ ] Record exact action SHA/image/platform, passing and blocked tests, and residual requirements for every issue. Prepare consolidated release notes without publishing.
- [ ] Obtain final independent review, push the local branch using only `cloud-orbitor`, create and attach a PR, and link evidence to all seven issues. Leave issues with unmet runtime/external acceptance criteria open.
