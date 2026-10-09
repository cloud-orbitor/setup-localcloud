# CI runtime contract

Implement GitHub issues #1–#7 together on `codex/ci-runtime-reliability`.

- Keep the action independent of the CLI. Service IDs, readiness, SDK environment and dependency information come from the selected runtime image, not an adapter allowlist.
- Use an immutable image digest; preserve published action tags. Keep Firestore outside defaults and examples. Default services are `gcs,pubsub,bigquery`.
- Reuse an exact local image before pulling. An optional OCI image cache must cryptographically bind its selected platform and configuration to the requested digest. Cache no credentials or application data. Native GitHub service pulls precede steps.
- Preserve production-endpoint rejection, environment validation and loopback publication. External HTTP runtimes can supply explicit canonical-to-published port mappings.
- Docker execution is opt-in. Give an owned runtime a unique network and data volume. Cleanup must verify ownership and remove only that job's runtime and children. Existing runtimes remain their owner's responsibility.
- Optional MCP attaches to `/mcp` on the same runtime and project. Write/destructive permissions remain off. Generate a job-local stdio configuration and forward protocol messages without starting another environment.
- Qualification distinguishes catalog/configuration checks, SDK operations, native workload execution, local image reuse and fresh hosted pulls. Unsupported services fail before project creation; prerequisite failures name the missing dependency.
- Prepare one release candidate and a visible PR. Do not publish or move Marketplace tags in this task. A registry mirror must preserve multiarchitecture digests and be verified before becoming the default.
