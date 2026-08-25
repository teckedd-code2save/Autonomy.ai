# Security Model

## Primary invariant

> **Agents receive capabilities, not provider credentials.**

The agent can be authorized to execute a computation without being authorized to retrieve the infrastructure secret used to perform that computation.

## Threat model

Assume the calling agent may:

- be prompt-injected
- construct malicious workload parameters
- request excessive resources
- attempt to exfiltrate credentials
- induce provider errors that contain sensitive context
- repeatedly invoke compute to create cost
- request a more powerful GPU than intended
- intentionally create long-running processes

Assume application logs may later be visible to developers/operators and therefore should not contain raw provider secrets.

Assume provider SDKs may surface verbose errors containing request metadata.

## Gate 0 controls

### Agent/API authentication

The POC uses one `AGENT_API_KEY` and compares it with `crypto.timingSafeEqual`.

This is acceptable only for Gate 0. Multi-tenant production should use short-lived signed capabilities or equivalent workload identity.

### Request-size limit

JSON request bodies are capped at 64 KiB.

### Runtime policy

Requests above five minutes are rejected **before** the Modal provider adapter is called.

This proves a useful ordering property:

```text
policy -> route -> credential retrieval -> provider call
```

not:

```text
credential retrieval -> maybe policy later
```

### Late secret retrieval

`MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` are fetched only inside `ModalProvider.execute()`.

The agent-facing `ComputeService` does not know either value.

### Secret location

Modal credentials belong in Infisical under `/providers/modal`, not in `.env`, Git, task prompts, agent memory, or an LLM tool schema.

The runtime environment contains only the Infisical machine identity bootstrap credentials and project metadata.

### Error sanitization

The HTTP API does not serialize the full provider exception. It returns a generic `execution_failed` response.

Detailed errors need structured redaction before production observability is added.

### Resource cleanup

The Modal Sandbox is terminated in `finally`, including on command/output errors.

## What Gate 0 does not yet protect

### Secret-zero bootstrap

Universal Auth itself uses a client ID + client secret. That bootstrap secret must still be protected by the deployment environment.

Future options include infrastructure-native workload identity, short-lived bootstrap tokens, or Infisical mechanisms that reduce static secret-zero exposure.

### Per-user provider credentials

Gate 0 assumes one Modal credential path. Multi-tenant operation will require a provider-connection mapping and path/identity strategy that prevents cross-tenant access.

### Arbitrary workload safety

A user-authorized command can still be malicious. Production execution policy needs decisions around:

- allowed images/registries
- outbound networking
- filesystem mounts
- secrets injected into the workload
- maximum CPU/RAM/GPU
- persistent volume access
- public ports
- image provenance

### Cost abuse

Runtime limits are only one dimension. Production must enforce per-agent/workspace budgets and concurrent-execution limits.

### Output data leakage

stdout/stderr may contain secrets produced by the workload itself. We currently guarantee only that **gateway-managed Modal credentials** are not included by our response construction.

Production should implement output size limits and configurable redaction.

## Infisical Agent Proxy experiment

Infisical's Agent Proxy is worth testing after the basic Modal flow succeeds because it is designed to inject credentials at the outbound network boundary so untrusted agent code need not see them.

However, Modal's client communicates through its own SDK transport, so compatibility must be proven rather than assumed. Gate 0 therefore uses explicit SDK secret retrieval first.

If Agent Proxy works cleanly with Modal's transport, the trusted execution-worker boundary can shrink further.

## Modal Service Users

For team/enterprise deployments, provider-native automation identities should be preferred over powerful personal credentials where available. Modal service users/environment roles are a natural future integration because the router can be scoped to specific environments rather than a user's entire account.

## Production authorization target

A future agent capability may look conceptually like:

```json
{
  "sub": "agent:research-01",
  "workspace": "ws_123",
  "permissions": ["compute.execute", "compute.status"],
  "providers": ["modal", "huggingface"],
  "maxTaskSpendUsd": 2,
  "maxRuntimeSeconds": 1800,
  "maxGpuClass": "A10",
  "exp": 1787529600
}
```

The agent can present this capability, but it still cannot call a "get provider secret" operation because no such agent-facing operation exists.

## Security tests to add

1. Provider credential cannot appear in execution result.
2. Provider credential cannot appear in sanitized error response.
3. Runtime violation fails before credential broker invocation.
4. Unsupported provider fails before secret retrieval.
5. Disallowed GPU class fails before secret retrieval.
6. Revoked agent capability cannot run compute.
7. Cross-workspace provider connection ID is rejected.
8. Sandbox is terminated after stdout read failure.
9. Sandbox is terminated after timeout.
10. Concurrent execution quota is enforced.
11. Provider secret rotation requires no agent configuration change.
12. Provider disconnect immediately removes it from routing candidates.

## Rule of thumb

If a design requires placing a cloud/provider token in an LLM prompt, agent environment, MCP tool response, or general-purpose application log, the design has crossed the wrong trust boundary.
