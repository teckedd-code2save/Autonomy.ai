import { normalizeWorkload, enforcePolicy, truncateOutput, MAX_TIMEOUT_MS, MAX_OUTPUT_BYTES } from "./model.js";
import { ExecutionRegistry } from "./execution-registry.js";
import { Router } from "./router.js";

// ComputeService is the agent-facing seam. It never sees provider
// credentials: policy runs first, the router selects candidates from
// metadata, and only the chosen provider adapter touches the broker.
export class ComputeService {
  constructor({ providers, registry, router, routeOrder, policy, modalProvider } = {}) {
    // Legacy Gate 0 construction remains supported: { modalProvider }.
    let providerMap = providers;
    if (!providerMap && modalProvider) {
      providerMap = new Map([["modal", modalProvider]]);
    }
    if (!providerMap) {
      throw new Error("ComputeService requires providers");
    }

    this.registry = registry ?? new ExecutionRegistry();
    this.policy = {
      maxTimeoutMs: policy?.maxTimeoutMs ?? MAX_TIMEOUT_MS,
      allowedGpus: policy?.allowedGpus ?? [],
      allowedProviders: policy?.allowedProviders ?? [],
      maxOutputBytes: policy?.maxOutputBytes ?? MAX_OUTPUT_BYTES,
    };
    this.router = router ?? new Router({
      providers: providerMap,
      order: routeOrder ?? [...providerMap.keys()],
      registry: this.registry,
    });
  }

  listProviders() {
    return [...this.router.providers.values()].map((provider) => ({
      provider: provider.id,
      configured: provider.isConfigured?.() ?? true,
      ...(provider.capabilities?.() ?? {}),
    }));
  }

  async execute(request) {
    const workload = normalizeWorkload(request);

    // Policy BEFORE routing and BEFORE any credential retrieval.
    enforcePolicy(workload, this.policy);

    const { result, route } = await this.router.route(workload);

    const stdout = truncateOutput(result.stdout ?? "", this.policy.maxOutputBytes);
    const stderr = truncateOutput(result.stderr ?? "", this.policy.maxOutputBytes);

    return {
      provider: result.provider,
      status: result.status ?? "succeeded",
      executionId: result.executionId,
      providerExecutionId: result.providerExecutionId ?? null,
      stdout: stdout.text,
      stderr: stderr.text,
      outputTruncated: stdout.truncated || stderr.truncated,
      ...(result.jobUrl ? { jobUrl: result.jobUrl } : {}),
      route,
    };
  }

  listExecutions() {
    return this.registry.list();
  }

  getExecution(id) {
    return this.registry.get(id);
  }

  async stopExecution(id) {
    return this.registry.stop(id);
  }
}
