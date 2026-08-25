import { ExecutionStatus } from "../model.js";
import { FailureCode, ProviderError } from "../failures.js";

export class ModalProvider {
  constructor({ credentialBroker, appName, clientFactory = null }) {
    this.id = "modal";
    this.credentialBroker = credentialBroker;
    this.appName = appName;
    this.clientFactory = clientFactory;
  }

  async #createClient(credentials) {
    if (this.clientFactory) return this.clientFactory(credentials);
    const { ModalClient } = await import("modal");
    return new ModalClient(credentials);
  }

  isConfigured() {
    // Brokers that do not implement the metadata check are assumed configured.
    return this.credentialBroker?.hasModalCredentials?.() ?? true;
  }

  capabilities() {
    return {
      provider: this.id,
      accelerators: ["T4", "L4", "A10G", "A100", "H100", "H200"],
      maxTimeoutMs: 300_000,
      artifacts: "stdout/stderr",
    };
  }

  async testConnection() {
    const credentials = await this.credentialBroker.getModalCredentials();
    const modal = await this.#createClient(credentials);

    try {
      const app = await modal.apps.fromName(this.appName, { createIfMissing: true });
      return {
        provider: this.id,
        connected: true,
        appId: app?.appId ?? null,
      };
    } finally {
      modal.close?.();
    }
  }

  async execute(workload, { onHandle } = {}) {
    let credentials;
    try {
      credentials = await this.credentialBroker.getModalCredentials();
    } catch (error) {
      throw new ProviderError({
        provider: this.id,
        code: FailureCode.AUTH_INVALID,
        message: "no Modal credential is connected",
        cause: error,
      });
    }
    const modal = await this.#createClient(credentials);
    let sandbox;

    try {
      const app = await modal.apps.fromName(this.appName, { createIfMissing: true });
      const image = modal.images.fromRegistry(workload.image ?? "python:3.13-slim");
      const params = {
        command: workload.command,
        timeoutMs: workload.timeoutMs ?? 60_000,
      };
      if (workload.gpu) params.gpu = workload.gpu;

      sandbox = await modal.sandboxes.create(app, image, params);

      onHandle?.({
        providerExecutionId: sandbox.sandboxId,
        stop: async () => sandbox.terminate(),
      });

      const [stdout, stderr] = await Promise.all([
        sandbox.stdout.readText(),
        sandbox.stderr.readText(),
      ]);

      return {
        provider: this.id,
        status: ExecutionStatus.SUCCEEDED,
        executionId: sandbox.sandboxId,
        stdout,
        stderr,
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      // Failure before the sandbox exists means the route itself failed
      // (capacity/quota/submission): fallback-eligible. Failure after
      // submission means the workload ran and failed: not eligible.
      throw new ProviderError({
        provider: this.id,
        code: sandbox ? FailureCode.EXECUTION_ERROR : FailureCode.PROVIDER_UNAVAILABLE,
        message: `modal execution failed: ${error?.message ?? "unknown error"}`,
        cause: error,
      });
    } finally {
      if (sandbox) await sandbox.terminate().catch(() => {});
      modal.close?.();
    }
  }
}
