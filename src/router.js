import { ExecutionStatus } from "./model.js";
import { isProviderError, ProviderError, FailureCode } from "./failures.js";

// Gate 3 deterministic fallback router.
//
// This recreates the incident that started the product:
//
//   HF job requested
//    -> HF cannot run / billing 402
//    -> Modal is connected and feasible
//    -> same workload runs on Modal
//    -> result returns to agent
//
// Deliberately NOT a general optimizer yet. Candidate order is fixed and
// failover happens only on fallback-eligible failure classifications, with
// full provenance recorded in the execution registry.
//
// Failover never silently relaxes budget, runtime limit, hardware
// requirements, or provider policy: the same normalized workload is passed
// unchanged to every candidate.
export class Router {
  constructor({ providers, order, registry }) {
    // providers: Map<string, ComputeProvider>
    this.providers = providers;
    this.order = order;
    this.registry = registry;
  }

  candidatesFor(workload) {
    if (workload.provider) {
      const provider = this.providers.get(workload.provider);
      if (!provider) {
        throw new ProviderError({
          provider: workload.provider,
          code: FailureCode.PROVIDER_UNAVAILABLE,
          message: `provider is not connected: ${workload.provider}`,
        });
      }
      return [provider];
    }

    const candidates = this.order
      .map((id) => this.providers.get(id))
      .filter((provider) => provider && provider.isConfigured?.() !== false);

    if (candidates.length === 0) {
      throw new ProviderError({
        provider: "gateway",
        code: FailureCode.PROVIDER_UNAVAILABLE,
        message: "no compute provider is connected",
      });
    }
    return candidates;
  }

  async route(workload, { onAttempt } = {}) {
    const candidates = this.candidatesFor(workload);
    const attempts = [];
    let parentExecutionId = null;
    let lastError = null;

    for (const provider of candidates) {
      const record = this.registry.create({
        workload,
        provider: provider.id,
        parentExecutionId,
        routeReason: parentExecutionId ? `fallback from ${parentExecutionId}` : "primary route",
      });
      onAttempt?.(record);

      this.registry.transition(record.id, ExecutionStatus.RUNNING);

      try {
        const result = await provider.execute(workload, {
          onHandle: ({ providerExecutionId, stop }) => {
            this.registry.transition(record.id, ExecutionStatus.RUNNING, { providerExecutionId });
            if (stop) this.registry.registerStopHandle(record.id, stop);
          },
        });

        this.registry.transition(record.id, ExecutionStatus.SUCCEEDED, {
          providerExecutionId: this.registry.get(record.id).providerExecutionId ?? result.executionId,
        });

        attempts.push({
          executionId: record.id,
          provider: provider.id,
          status: ExecutionStatus.SUCCEEDED,
        });

        return {
          result: { ...result, executionId: record.id, providerExecutionId: result.executionId },
          record: this.registry.get(record.id),
          route: {
            candidates: candidates.map((p) => p.id),
            attempts,
          },
        };
      } catch (error) {
        const classified = isProviderError(error)
          ? error
          : new ProviderError({
              provider: provider.id,
              code: FailureCode.EXECUTION_ERROR,
              message: error?.message ?? "unknown provider error",
              cause: error,
            });

        this.registry.transition(record.id, ExecutionStatus.FAILED, {
          failureCode: classified.code,
        });
        attempts.push({
          executionId: record.id,
          provider: provider.id,
          status: ExecutionStatus.FAILED,
          failureCode: classified.code,
          fallbackEligible: classified.fallbackEligible,
        });
        lastError = classified;

        if (!classified.fallbackEligible) break; // the workload itself failed
        parentExecutionId = record.id; // continue to the next candidate
      }
    }

    const failure = new Error(
      `all routes failed (${attempts.map((a) => `${a.provider}:${a.failureCode}`).join(", ")})`,
    );
    failure.name = "RoutingError";
    failure.attempts = attempts;
    failure.code = lastError?.code ?? FailureCode.PROVIDER_UNAVAILABLE;
    throw failure;
  }
}
