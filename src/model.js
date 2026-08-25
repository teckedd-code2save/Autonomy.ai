import crypto from "node:crypto";

// Provider-neutral workload model (Gate 1). The public API accepts either the
// flat Gate 0 shape or the semantic intent shape; both normalize to the same
// internal WorkloadIntent.

export const DEFAULT_IMAGE = "python:3.13-slim";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 300_000; // Gate 1 policy: 5 minutes
export const MAX_OUTPUT_BYTES = 256 * 1024; // per stream

export const ExecutionStatus = Object.freeze({
  QUEUED: "queued",
  STARTING: "starting",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  STOPPED: "stopped",
});

export function newExecutionId() {
  // Time-ordered prefix + random suffix: sortable, collision-safe, opaque.
  const time = Date.now().toString(36);
  const rand = crypto.randomBytes(6).toString("hex");
  return `exec_${time}_${rand}`;
}

export class PolicyViolation extends Error {
  constructor(message) {
    super(message);
    this.name = "PolicyViolation";
  }
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Normalize a raw execute request into a WorkloadIntent.
 *
 * Accepted shapes:
 *   Gate 0 flat:   { image, command, gpu, timeoutMs, provider }
 *   Intent shape:  { kind, runtime: { image, command }, requirements,
 *                    constraints, economics, provider }
 */
export function normalizeWorkload(request) {
  if (!request || typeof request !== "object") {
    throw new ValidationError("request body must be a JSON object");
  }

  const runtime = request.runtime ?? {};
  const constraints = request.constraints ?? {};
  const requirements = request.requirements ?? {};
  const economics = request.economics ?? {};

  const command = request.command ?? runtime.command;
  if (!Array.isArray(command) || command.length === 0 || !command.every((c) => typeof c === "string")) {
    throw new ValidationError("command must be a non-empty array of strings");
  }

  const timeoutMs = request.timeoutMs
    ?? (constraints.maxRuntimeSeconds != null ? constraints.maxRuntimeSeconds * 1000 : undefined)
    ?? DEFAULT_TIMEOUT_MS;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ValidationError("timeout must be a positive number");
  }

  const gpu = request.gpu
    ?? (requirements.accelerator === "gpu" ? requirements.gpuClass : undefined)
    ?? undefined;

  return {
    kind: request.kind ?? "batch",
    image: request.image ?? runtime.image ?? DEFAULT_IMAGE,
    command,
    gpu,
    timeoutMs,
    provider: request.provider ?? undefined,
    requirements: {
      accelerator: requirements.accelerator ?? (gpu ? "gpu" : "cpu"),
      gpuClass: gpu,
      cpu: requirements.cpu,
      memoryGb: requirements.memoryGb,
      minVramGb: requirements.minVramGb,
    },
    constraints: {
      maxRuntimeMs: timeoutMs,
      network: constraints.network ?? "egress-only",
    },
    economics: {
      maxSpendUsd: economics.maxSpendUsd,
      optimizeFor: economics.optimizeFor ?? "effective_cost",
    },
  };
}

/**
 * Enforce runtime policy BEFORE any credential retrieval or provider call.
 * Ordering invariant: policy -> route -> credential retrieval -> provider call.
 */
export function enforcePolicy(workload, { maxTimeoutMs = MAX_TIMEOUT_MS, allowedGpus, allowedProviders } = {}) {
  if (workload.timeoutMs > maxTimeoutMs) {
    throw new PolicyViolation(`Gate policy limits execution to ${Math.round(maxTimeoutMs / 60000)} minutes`);
  }

  if (workload.gpu && Array.isArray(allowedGpus) && allowedGpus.length > 0) {
    const allowed = allowedGpus.map((g) => g.toLowerCase());
    if (!allowed.includes(String(workload.gpu).toLowerCase())) {
      throw new PolicyViolation(`GPU class not allowed by policy: ${workload.gpu}`);
    }
  }

  if (workload.provider && Array.isArray(allowedProviders) && allowedProviders.length > 0) {
    if (!allowedProviders.includes(workload.provider)) {
      throw new PolicyViolation(`provider not allowed by policy: ${workload.provider}`);
    }
  }
}

export function truncateOutput(text, maxBytes = MAX_OUTPUT_BYTES) {
  if (typeof text !== "string") return { text: "", truncated: false };
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true };
}
