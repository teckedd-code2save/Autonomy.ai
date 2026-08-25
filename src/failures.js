// Normalized provider failure taxonomy. The router's fallback decision depends
// ONLY on this classification, never on provider-specific error shapes.
//
// Fallback-eligible codes describe failures of the route itself (billing,
// capacity, auth, unavailability): the workload never really ran, so trying the
// next candidate is safe and is exactly the product's reason to exist.
//
// Non-eligible codes (notably execution_error) mean the workload ran and
// failed: retrying on another provider would repeat the same failure and burn
// budget, so the router stops.

export const FailureCode = Object.freeze({
  BILLING_UNAVAILABLE: "billing_unavailable", // e.g. HF 402 Payment Required
  AUTH_INVALID: "auth_invalid", // 401/403 from the provider
  RATE_LIMITED: "rate_limited", // 429
  PROVIDER_UNAVAILABLE: "provider_unavailable", // 5xx, network, submit timeout
  EXECUTION_ERROR: "execution_error", // workload ran and failed
  STOPPED: "stopped", // stopped via the gateway stop endpoint
});

const FALLBACK_ELIGIBLE = new Set([
  FailureCode.BILLING_UNAVAILABLE,
  FailureCode.AUTH_INVALID,
  FailureCode.PROVIDER_UNAVAILABLE,
]);

export class ProviderError extends Error {
  constructor({ provider, code, message, statusCode, cause }) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
    this.statusCode = statusCode;
    this.cause = cause;
    this.fallbackEligible = FALLBACK_ELIGIBLE.has(code);
  }
}

export function classifyHttpStatus(provider, statusCode, message) {
  if (statusCode === 402) {
    return new ProviderError({
      provider,
      code: FailureCode.BILLING_UNAVAILABLE,
      statusCode,
      message: message ?? "provider account cannot run this workload (billing/quota)",
    });
  }
  if (statusCode === 401 || statusCode === 403) {
    return new ProviderError({
      provider,
      code: FailureCode.AUTH_INVALID,
      statusCode,
      message: message ?? "provider rejected the credential",
    });
  }
  if (statusCode === 429) {
    return new ProviderError({
      provider,
      code: FailureCode.RATE_LIMITED,
      statusCode,
      message: message ?? "provider rate limit reached",
    });
  }
  if (statusCode >= 500) {
    return new ProviderError({
      provider,
      code: FailureCode.PROVIDER_UNAVAILABLE,
      statusCode,
      message: message ?? "provider is unavailable",
    });
  }
  return new ProviderError({
    provider,
    code: FailureCode.EXECUTION_ERROR,
    statusCode,
    message: message ?? `provider returned HTTP ${statusCode}`,
  });
}

export function isProviderError(error) {
  return error instanceof ProviderError || (error && error.name === "ProviderError" && typeof error.code === "string");
}
