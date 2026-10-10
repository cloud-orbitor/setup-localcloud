# Consolidated CI integration update — release candidate

This candidate prepares one update for the CI integration backlog. It is not a published Marketplace release; existing v0.1.0 tags stay unchanged.

- Reuse an exact locally cached runtime image and select the Docker server's platform explicitly. Optional OCI cache restoration verifies the pinned manifest, platform, configuration and layer hashes before use.
- Get service IDs, environment keys and execution requirements from the selected runtime. Unknown, unsupported, disabled and missing-prerequisite selections fail before project creation.
- Connect to remapped existing HTTP runtimes with `port-map`, and provide runner/container SDK environment files.
- Start each owned runtime with a unique network and data volume. Native workload execution uses explicitly enabled Docker socket access. Cleanup verifies ownership before removing job resources, including recovery from partial startup.
- Generate an optional job-local read-only MCP configuration targeting the same runtime and project. The stdio bridge forwards native MCP messages, cancellation and callbacks without installing the CLI or starting another runtime.
- Keep the explicit Storage, Pub/Sub and BigQuery examples. Firestore remains outside default/example selection. Service choice and runtime-image choice are independent of action releases.
- Add catalog, application-container, MCP, native-workload and cache qualification workflows, plus an explicitly dispatched digest-preserving registry mirror workflow.

Review the implementation plan and evidence ledger before publication. Runtime-specific defects, private runtime-repository access, mirror publication and fresh hosted evidence remain separate acceptance gates. No binary attachment is needed for this JavaScript action.
