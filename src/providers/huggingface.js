import { ExecutionStatus } from "../model.js";
import { FailureCode, ProviderError, classifyHttpStatus } from "../failures.js";

// Gateway GPU class -> HF Jobs hardware flavor.
const GPU_TO_FLAVOR = {
  t4: "t4-small",
  l4: "l4x1",
  a10g: "a10g-small",
  a100: "a100-large",
  h100: "h200", // HF Jobs exposes H200 as the top-tier flavor
  h200: "h200",
};

const TERMINAL_STAGES = new Set(["COMPLETED", "CANCELED", "ERROR", "DELETED"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hugging Face Jobs adapter (Gate 2). Pure HTTPS against the Jobs API, so the
// only credential is an HF token fetched late from the credential broker.
// `fetchImpl` is injectable for tests and for future transport hardening.
export class HuggingFaceProvider {
  constructor({ credentialBroker, namespace, endpoint = "https://huggingface.co", fetchImpl = null, pollIntervalMs = 2_000 }) {
    this.id = "huggingface";
    this.credentialBroker = credentialBroker;
    this.namespace = namespace;
    this.endpoint = endpoint.replace(/\/$/, "");
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.pollIntervalMs = pollIntervalMs;
  }

  async #getToken() {
    let credentials;
    try {
      credentials = await this.credentialBroker.getHuggingFaceCredentials();
    } catch (error) {
      // Broker-side failure (secret missing, auth broken): the route is not
      // viable. Fallback-eligible so the router can continue elsewhere.
      throw new ProviderError({
        provider: this.id,
        code: FailureCode.AUTH_INVALID,
        message: "no Hugging Face credential is connected",
        cause: error,
      });
    }
    if (!credentials?.token) {
      throw new ProviderError({
        provider: this.id,
        code: FailureCode.AUTH_INVALID,
        message: "no Hugging Face credential is connected",
      });
    }
    return credentials.token;
  }

  async #request(method, path, { body } = {}) {
    const token = await this.#getToken();
    let response;
    try {
      response = await this.fetchImpl(`${this.endpoint}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      // Network-level failure: the route itself is unavailable.
      throw new ProviderError({
        provider: this.id,
        code: FailureCode.PROVIDER_UNAVAILABLE,
        message: "could not reach Hugging Face",
        cause: error,
      });
    }

    if (!response.ok) {
      // Read the body only to classify; it is never propagated to callers.
      const detail = await response.text().catch(() => "");
      throw classifyHttpStatus(this.id, response.status, detail || undefined);
    }
    return response;
  }

  isConfigured() {
    // Brokers that do not implement the metadata check are assumed configured.
    return this.credentialBroker?.hasHuggingFaceCredentials?.() ?? true;
  }

  capabilities() {
    return {
      provider: this.id,
      accelerators: Object.keys(GPU_TO_FLAVOR).map((g) => g.toUpperCase()),
      flavors: Object.values(GPU_TO_FLAVOR),
      cpuFlavors: ["cpu-basic", "cpu-upgrade", "cpu-performance"],
      maxTimeoutMs: 300_000,
      artifacts: "logs",
    };
  }

  async testConnection() {
    const response = await this.#request("GET", "/api/whoami-v2");
    const identity = await response.json();
    return {
      provider: this.id,
      connected: true,
      account: identity?.name ?? null,
    };
  }

  async status(jobId) {
    const response = await this.#request("GET", `/api/jobs/${this.namespace}/${jobId}`);
    return response.json();
  }

  async stop(jobId) {
    await this.#request("POST", `/api/jobs/${this.namespace}/${jobId}/cancel`);
  }

  async execute(workload, { onHandle } = {}) {
    if (!this.namespace) {
      throw new ProviderError({
        provider: this.id,
        code: FailureCode.AUTH_INVALID,
        message: "HF_NAMESPACE is not configured for the Hugging Face provider",
      });
    }

    const flavor = workload.gpu
      ? GPU_TO_FLAVOR[String(workload.gpu).toLowerCase()] ?? "cpu-basic"
      : "cpu-basic";

    const jobSpec = {
      dockerImage: workload.image,
      command: workload.command,
      arguments: [],
      environment: {},
      flavor,
      timeoutSeconds: Math.ceil(workload.timeoutMs / 1000),
    };

    const created = await (await this.#request("POST", `/api/jobs/${this.namespace}`, { body: jobSpec })).json();
    const jobId = created?.id;
    if (!jobId) {
      throw new ProviderError({
        provider: this.id,
        code: FailureCode.PROVIDER_UNAVAILABLE,
        message: "Hugging Face did not return a job id",
      });
    }

    onHandle?.({
      providerExecutionId: jobId,
      stop: () => this.stop(jobId),
    });

    const deadline = Date.now() + workload.timeoutMs + 120_000; // provider grace beyond workload timeout
    let job = created;
    while (!TERMINAL_STAGES.has(job?.status?.stage)) {
      if (Date.now() > deadline) {
        await this.stop(jobId).catch(() => {});
        throw new ProviderError({
          provider: this.id,
          code: FailureCode.EXECUTION_ERROR,
          message: "job exceeded its timeout budget",
        });
      }
      await sleep(this.pollIntervalMs);
      job = await this.status(jobId);
    }

    const logsResponse = await this.#request("GET", `/api/jobs/${this.namespace}/${jobId}/logs`);
    const logs = await logsResponse.text();

    const stage = job.status.stage;
    if (stage === "COMPLETED") {
      return {
        provider: this.id,
        status: ExecutionStatus.SUCCEEDED,
        executionId: jobId,
        stdout: logs,
        stderr: "",
        jobUrl: job?.url ?? `${this.endpoint}/jobs/${this.namespace}/${jobId}`,
      };
    }

    if (stage === "CANCELED") {
      throw new ProviderError({
        provider: this.id,
        code: FailureCode.STOPPED,
        message: "job was canceled",
      });
    }

    // ERROR / DELETED: the workload itself failed. NOT fallback-eligible.
    throw new ProviderError({
      provider: this.id,
      code: FailureCode.EXECUTION_ERROR,
      message: `job reached stage ${stage}: ${job?.status?.message ?? "no message"}`,
    });
  }
}
