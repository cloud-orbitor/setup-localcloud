# Release evidence

## Documentation update, 2026-10-09

The guide and README use published v0.1.0 with explicit `services: gcs,pubsub,bigquery`; selecting BigQuery does not require a new action release. Local ARM64 checks against the already-cached exact 0.1.5 image digest passed with the v0.1.0 runtime implementation (`de6d236db036be4c8b96879392d22a1feb5047c6`): Storage upload/readback, Pub/Sub publish/pull/acknowledgement, BigQuery dataset/table/insert/query readback, and owned container/anonymous-volume removal. The documented Docker-only bootstrap also passed selected-service readiness, missing-project creation, and generated environment export inside that owned container. This inner-container bootstrap check does not establish native GitHub host networking or fresh registry pulls.

Fresh hosted [guide checks](https://github.com/cloud-orbitor/setup-localcloud/actions/runs/37992211847), [published-action consumer checks](https://github.com/cloud-orbitor/setup-localcloud/actions/runs/37992215149), and [qualification](https://github.com/cloud-orbitor/setup-localcloud/actions/runs/37992083053) were blocked before runtime startup by Docker Hub's anonymous pull limit (`toomanyrequests`). Hosted unit tests passed; these failed image-pull runs do not establish new SDK or cleanup evidence. The guide documents registry authentication for action-managed and native-service routes. Distribution reliability is tracked in [issue #6](https://github.com/cloud-orbitor/setup-localcloud/issues/6). No repository secrets were added and no new action release was published.

## Unreleased changes — publication on hold

The selected/default profile is now `gcs,pubsub,bigquery`; Firestore is excluded from current examples and qualification. The pinned 0.1.5 image passed local ARM64 fresh action startup, generated endpoints, Storage object readback, Pub/Sub message readback, BigQuery dataset/table creation, row insertion, SQL readback, and automatic container/anonymous-volume cleanup. Python BigQuery 3.46.1 uses the generated endpoint through ClientOptions with AnonymousCredentials. Ten Node 24 tests pass. [Hosted qualification 37989290869](https://github.com/cloud-orbitor/setup-localcloud/actions/runs/37989290869) and [independent corrected-SHA consumer 37989291848](https://github.com/cloud-orbitor/setup-localcloud/actions/runs/37989291848) both passed on Ubuntu 24.04 AMD64. The consumer verified all three SDK readbacks and actual automatic post-hook removal of the container and anonymous volume. Corrected code SHA: `5c22a985426ff56aebb2d11c09744eccea307444`.

## Historical release 0.1.0

The evidence below describes the original 0.1.0 profile only. It is retained for provenance and is not a current Firestore support claim.

Runtime: `agentcloud/localcloud@sha256:88e85b86b294e1e4f71b8c63ec43de79d170946ff39556f0e2709f66aa0d368c` (release tag 0.1.5).

### Local ARM64 (0.1.0)

The exact multi-architecture release image passed fresh action startup, generated SDK settings, Google Python SDK Cloud Storage upload/download, Pub/Sub publish/pull/acknowledgement and Firestore write/readback. Ownership-checked cleanup removed the action's container and anonymous volume; a second cleanup succeeded as a no-op. Ten Node 24 tests passed. No CLI was installed by the action.

### GitHub hosted AMD64 (0.1.0)

[Qualification run 37980659078](https://github.com/cloud-orbitor/setup-localcloud/actions/runs/37980659078) passed all four jobs on Ubuntu 24.04: unit, managed Docker SDK readback/owned cleanup, native service SDK readback/preservation, and rejected-service failure cleanup. Qualified action code commit: `c2add0415e1b2bfd3dc0e9a5858f35c8951222f0`.

The qualification used Python 3.12 with Storage 3.6.0, Pub/Sub 2.33.0 and Firestore 2.23.0. The local check used Python 3.13. Other SDK profiles, container-job consumers, same-container toolchains, Docker-backed workloads and runner-loss cleanup were not qualified for this release.

### Publication (0.1.0)

[Independent public-SHA consumer run 37981540971](https://github.com/cloud-orbitor/setup-localcloud/actions/runs/37981540971) passed Cloud Storage, Pub/Sub and Firestore readback using `cloud-orbitor/setup-localcloud@c2add0415e1b2bfd3dc0e9a5858f35c8951222f0`. A checker registered before setup ran after the setup post hook and verified that the actual container and anonymous volume no longer existed. This verifies automatic cleanup, rather than only calling the cleanup function in a test step.

[v0.1.0 is publicly released](https://github.com/cloud-orbitor/setup-localcloud/releases/tag/v0.1.0), pinned to commit `de6d236db036be4c8b96879392d22a1feb5047c6`. [Release-tag consumer run 37982317639](https://github.com/cloud-orbitor/setup-localcloud/actions/runs/37982317639) passed all three SDK readbacks and actual automatic post cleanup using `cloud-orbitor/setup-localcloud@v0.1.0`.

A repository release is separate from Marketplace publication. The owner completed the agreement and account requirements, and [Setup LocalCloud is listed in Marketplace](https://github.com/marketplace/actions/setup-localcloud) at v0.1.0. The v0.1.1 draft remains unpublished while the [consolidated release backlog](https://github.com/cloud-orbitor/setup-localcloud/issues/5) is reviewed. Service selection through the `services` input does not require another action release.


## Consolidated implementation candidate (2026-10-09)

Branch `codex/ci-runtime-reliability` implements issues #1–#7; see the implementation plan and issue-resolution table. No action tag or Marketplace release was published.

Local Node 24.21.0 checks: 30 tests pass, including exact-image reuse, platform selection, OCI integrity, prerequisite/unsupported-service rejection, remapped endpoints, ownership recovery, native MCP JSON/SSE forwarding, callbacks and saturated cancellation. Independent source review approved image acquisition and runtime/MCP corrections.

Pinned image `agentcloud/localcloud@sha256:88e85b86b294e1e4f71b8c63ec43de79d170946ff39556f0e2709f66aa0d368c`, linux/arm64, cached store: 21 selected non-Firestore/non-execution services passed catalog/readiness/environment checks. This is environment qualification, not a claim that every service operation or language SDK was exercised. Python Storage 3.6.0, Pub/Sub 2.33.0 and BigQuery 3.46.1 passed resource write/readback and cleanup. SDK checks also passed inside the runtime and in a separate application container on its owned network.

Python MCP SDK 1.26.0 passed initialize, tools/resources discovery, SDK environment targeting the same gateway/project and SELECT 1 through the action's stdio bridge. Native Cloud Run (Python SDK 0.16.2) passed deployment and actual HTTP readback. GKE (Python SDK 2.67.0) passed cluster lifecycle, native Kubernetes API, ready node and native pod execution. Owned root/network/volume cleanup passed.

Dataproc (Python SDK 5.31.0) passed cluster creation and a native Spark job. The published runtime's delete LRO omits the protobuf Empty response and triggers a Google SDK future error. A separately prepared runtime correction (`60e1707b826b75ced1dc54f1af5be41bf7d2f9bf`) passes all eight Dataproc service tests, including the regression that failed before the fix. It is not a published image; cloud-orbitor currently lacks private runtime-repository access. The native qualification script now treats SDK deletion errors as failures rather than hiding them.

The website guide production build (Node 24.21.0/pnpm 12.9.1), installer checks and context refresh passed. The repository guide is regenerated from its rendered Markdown twin. Website publication remains in site PR #5. Optional cache transport benchmarks and fresh hosted runs are recorded separately when available; local cached startup does not prove fresh registry pulls. Public mirror publication is pending the owner's decision, and no unverified mirror replaces the default.


Candidate hosted check [38007776335](https://github.com/cloud-orbitor/setup-localcloud/actions/runs/38007776335), action SHA `dff0cc550497006ab94884a8479b3dd876e2eff6`: all enabled jobs passed (30 unit tests, managed setup/automatic post cleanup, native services, service-name container job, MCP, separate/same-container applications and catalog profile). Docker Hub cold acquisition succeeded in this run; the older quota failures remain historical evidence of an intermittent distribution problem. Native execution and publishing jobs were deliberately not enabled in that run.

Local derived runtime `sha256:388c6a90908b99c0616cc9b50fbf91c2b4f387a8571b0d2e6e6e5c045eab92b1` overlays the rebuilt JAR from runtime fix commit `60e1707b826b75ced1dc54f1af5be41bf7d2f9bf` onto the pinned published base. Dataproc SDK cluster creation, native Spark, SDK deletion and owned cleanup passed with this candidate. This verifies a local image only; neither the published image nor runtime repository has been updated remotely.
