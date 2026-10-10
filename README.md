# LocalCloud for GitHub Actions

Run Google Cloud application tests and AI-agent checks against the LocalCloud Docker image. The setup action starts the image, waits for your selected services, prepares a local project, exports SDK settings, and removes its own container after the job. The LocalCloud CLI is optional.

**[Read the complete GitHub workflows user guide](docs/github-actions.md)** for the setup action, native GitHub service containers, Docker-only setup, SDK configuration, AI agents, inputs, troubleshooting, and cleanup. This guide is built from the LocalCloud site source; website publication awaits [site PR #5](https://github.com/LocalGCloud/LocalGCloud.github.io/pull/5). The live [service catalog](https://local.cloud/services/) and [compatibility matrix](https://local.cloud/compatibility/) provide detailed product capabilities.

## Quick start

The published example uses `v0.1.0`. The consolidated update is being reviewed on `codex/ci-runtime-reliability`; its implementation and checks are mapped to all seven issues in [the resolution table](docs/issue-resolution.md) and [implementation plan](docs/superpowers/plans/2026-10-09-ci-runtime-reliability.md).

Save this as `.github/workflows/localcloud.yml`. It uses the already-published action with explicit service selection and verifies a local BigQuery query:

```yaml
name: LocalCloud integration test
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
jobs:
  integration:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7.0.1
      - uses: actions/setup-python@v7.0.0
        with:
          python-version: '3.12'
      - name: Start LocalCloud
        id: localcloud
        uses: cloud-orbitor/setup-localcloud@v0.1.0
        with:
          services: gcs,pubsub,bigquery
          project-id: localcloud-ci
      - name: Install the SDK
        run: python -m pip install google-cloud-bigquery==3.46.1
      - name: Verify a local query
        run: |
          python - <<'PY'
          import os
          from google.auth.credentials import AnonymousCredentials
          from google.cloud import bigquery

          client = bigquery.Client(
              project=os.environ['GOOGLE_CLOUD_PROJECT'],
              credentials=AnonymousCredentials(),
              client_options={'api_endpoint': os.environ['BIGQUERY_EMULATOR_HOST']},
          )
          try:
              rows = list(client.query('SELECT 1 AS ok', timeout=30).result(timeout=30))
              assert rows[0].ok == 1
              print('LocalCloud BigQuery query passed')
          finally:
              client.close()
          PY
```

For your application's suite, replace the SDK install/query steps with your dependency installation and test commands. SDK settings reach subsequent steps in the same job. Python BigQuery requires the explicit endpoint and anonymous credentials shown above; consult [SDK examples](https://local.cloud/docs/sdk-examples/) for other clients.

## Select services

`services` is the complete comma-separated list your application needs. It is passed to the runtime; choosing another service does **not** require an action release. The three-service example is a tested profile, not the action's capability ceiling.

For example: `services: gcs,pubsub,bigquery,bigtable,spanner,kms,secretmanager`.

Always set the list explicitly. Published v0.1.0 includes Firestore in its default selection; Firestore is excluded from the examples here while the next release's defaults are reviewed.

| Service guide | ID for services | Workflow notes |
| --- | --- | --- |
| [Bigtable](https://local.cloud/services/bigtable/) | `bigtable` | See the service guide for SDK setup and operations. |
| [Spanner](https://local.cloud/services/spanner/) | `spanner` | See the service guide for SDK setup and operations. |
| [AlloyDB](https://local.cloud/services/alloydb/) | `alloydb` | See the service guide for SDK setup and operations. |
| [Memorystore (Redis/Valkey)](https://local.cloud/services/memorystore/) | `memorystore` | See the service guide for SDK setup and operations. |
| [Cloud SQL](https://local.cloud/services/cloud-sql/) | `cloudsql` | See the service guide for SDK setup and operations. |
| [Pub/Sub](https://local.cloud/services/pubsub/) | `pubsub` | See the service guide for SDK setup and operations. |
| [Cloud Tasks](https://local.cloud/services/cloud-tasks/) | `cloudtasks` | See the service guide for SDK setup and operations. |
| [Cloud Scheduler](https://local.cloud/services/cloud-scheduler/) | `cloudscheduler` | See the service guide for SDK setup and operations. |
| [Cloud Workflows](https://local.cloud/services/cloud-workflows/) | `workflows` | See the service guide for SDK setup and operations. |
| [Cloud Functions (2nd Gen)](https://local.cloud/services/cloud-functions/) | `cloudfunctions` | Function execution requires your own execution target. |
| [GKE](https://local.cloud/services/gke/) | `gke` | Cluster execution requires k3d and Docker; use a configured runtime. |
| [Compute Engine](https://local.cloud/services/compute-engine/) | `compute` | Unsupported locally; do not select for local tests. |
| [Cloud Run](https://local.cloud/services/cloud-run/) | `cloudrun` | Execution requires Docker runtime access; use a configured runtime. |
| [Vertex AI](https://local.cloud/services/vertex-ai/) | `vertexai` | Unsupported locally; do not select for local tests. |
| [Secret Manager](https://local.cloud/services/secret-manager/) | `secretmanager` | See the service guide for SDK setup and operations. |
| [Cloud IAM](https://local.cloud/services/cloud-iam/) | `cloudiam` | See the service guide for SDK setup and operations. |
| [Cloud KMS](https://local.cloud/services/cloud-kms/) | `kms` | See the service guide for SDK setup and operations. |
| [Cloud Resource Manager](https://local.cloud/services/cloud-resource-manager/) | `cloudresourcemanager` | See the service guide for SDK setup and operations. |
| [Service Usage](https://local.cloud/services/service-usage/) | `serviceusage` | See the service guide for SDK setup and operations. |
| [Cloud Billing](https://local.cloud/services/cloud-billing/) | `cloudbilling` | See the service guide for SDK setup and operations. |
| [Cloud Logging](https://local.cloud/services/cloud-logging/) | `logging` | See the service guide for SDK setup and operations. |
| [Cloud Monitoring](https://local.cloud/services/cloud-monitoring/) | `monitoring` | See the service guide for SDK setup and operations. |
| [Cloud Storage](https://local.cloud/services/cloud-storage/) | `gcs` | See the service guide for SDK setup and operations. |
| [BigQuery](https://local.cloud/services/bigquery/) | `bigquery` | See the service guide for SDK setup and operations. |
| [Dataproc](https://local.cloud/services/dataproc/) | `dataproc` | Execution requires Docker runtime access; use a configured runtime. |
| [Google Sheets](https://local.cloud/services/google-sheets/) | `sheets` | Read-only auxiliary fixture API. |

This table is copied from the site-rendered guide. Follow each service guide for supported operations and SDK configuration. Product support does not establish that every workflow has been tested through this action.

## Runtime and lifecycle

The following describes published `v0.1.0`; the preview features below extend its networking, execution and MCP configuration.

- Pin the action to the full commit shown on its [release page](https://github.com/cloud-orbitor/setup-localcloud/releases/tag/v0.1.0) for immutable action identity. The runtime image is independently pinned by digest; use the `image` input to select another compatible immutable image.
- Automatic mode requires a Linux Docker runner, gives LocalCloud a 4 GiB limit, publishes TCP ports on loopback, and rewrites generated endpoints to those ports.
- For a native service or independently started image, supply `runtime-url: http://host:5380` and canonical service ports. The runtime owner retains lifecycle control. The [full guide](docs/github-actions.md#use-the-image-without-the-action-or-cli) also shows setup without this action or the CLI.
- Dataproc, Cloud Run and GKE execution need additional runtime dependencies. Automatic mode currently disables Docker access inside LocalCloud; use a configured runtime and check the relevant service guide.
- Agents launched on the same runner inherit the SDK environment. MCP attachment is a separate integration; the action does not install or configure an MCP client.
- Normal post cleanup removes only the action-owned container and anonymous volume. Runner-loss recovery and container-job networking need their own checks.
- Shared runners can hit Docker Hub's anonymous pull limit before startup. The guide covers [registry authentication](docs/github-actions.md#docker-hub-pull-limits); distribution reliability is tracked in [issue #6](https://github.com/cloud-orbitor/setup-localcloud/issues/6).

## Licensing and support

The adapter is MIT-licensed. The separately distributed image is governed by the [LocalCloud license](https://local.cloud/license/). Automatic mode disables runtime telemetry; see [privacy](https://local.cloud/docs/privacy/). Validate production-sensitive behavior against real Google Cloud before deployment.

Report integration problems in [this repository's issues](https://github.com/cloud-orbitor/setup-localcloud/issues), with the action version, image digest, selected services, SDK versions, and sanitized errors. The [grouped integration backlog](https://github.com/cloud-orbitor/setup-localcloud/issues) is being collected for one consolidated update; v0.1.1 remains an unpublished draft.

## Development and checks

Use Node 24 and `node --test`. There are no npm runtime dependencies or generated bundles. [Guide checks](.github/workflows/guide.yml) exercise the documented published-action quick start and Docker-only bootstrap. [Consumer checks](.github/workflows/consumer.yml) exercise the published action. Candidate checks cover catalog configuration, runner/application-container SDKs, native execution, MCP and cleanup; optional cache and mirror workflows are explicitly dispatched. Exact run evidence lives in [docs/release-evidence.md](docs/release-evidence.md).

## Preview inputs and outputs

These features require the reviewed preview branch or its commit, not the published `v0.1.0` tag:

```yaml
- uses: cloud-orbitor/setup-localcloud@codex/ci-runtime-reliability
  id: localcloud
  with:
    services: gcs,pubsub,bigquery
    project-id: localcloud-ci
    mcp: 'true'
```

| Input | Purpose |
| --- | --- |
| `image-cache` | Optional restored OCI layout. The pinned root, platform, config and layers are verified before importing; otherwise use the Docker store or registry. |
| `port-map` | Existing-runtime canonical-to-published JSON port mapping. For `runtime-url: http://127.0.0.1:15380`, use `'{"5380":15380,"5382":15382,"5383":15383,"5388":15388}'` for the example profile. |
| `docker-access` | Default `'false'`; opt in to runner Docker socket access for native execution. Runtime prerequisites come from the image catalog. |
| `mcp` | Default `'false'`; create a job-local read-only MCP configuration attached to this gateway/project. No CLI installation. |

Outputs include `network`, `env-file`, `docker-env-file`, `mcp-url` and `mcp-config`, in addition to the gateway/container/project outputs. Use `docker-env-file` and the owned `network` when launching an application container; host loopback settings do not work inside it. The full guide explains the preview, lifecycle ownership and per-client SDK configuration.

Image reuse keeps application state fresh. Persistent runners reuse the exact local image; standard hosted runners need a restored image cache or registry delivery across jobs. Native services start before cache/login steps. The opt-in [cache workflow](.github/workflows/cache.yml) demonstrates trusted cache production and restoration; benchmark disk usage and load time before enabling it everywhere. The [mirror workflow](.github/workflows/mirror.yml) preserves all source platforms/digests and must be published and anonymously verified before use as a public default.
