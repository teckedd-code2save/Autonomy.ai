export class ModalProvider {
  constructor({ credentialBroker, appName, clientFactory = null }) {
    this.credentialBroker = credentialBroker;
    this.appName = appName;
    this.clientFactory = clientFactory;
  }

  async #createClient(credentials) {
    if (this.clientFactory) return this.clientFactory(credentials);
    const { ModalClient } = await import("modal");
    return new ModalClient(credentials);
  }

  async testConnection() {
    const credentials = await this.credentialBroker.getModalCredentials();
    const modal = await this.#createClient(credentials);

    try {
      const app = await modal.apps.fromName(this.appName, { createIfMissing: true });
      return {
        provider: "modal",
        connected: true,
        appId: app?.appId ?? null,
      };
    } finally {
      modal.close?.();
    }
  }

  async execute(workload) {
    const credentials = await this.credentialBroker.getModalCredentials();
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
      const [stdout, stderr] = await Promise.all([
        sandbox.stdout.readText(),
        sandbox.stderr.readText(),
      ]);

      return {
        provider: "modal",
        executionId: sandbox.sandboxId,
        stdout,
        stderr,
      };
    } finally {
      if (sandbox) await sandbox.terminate().catch(() => {});
      modal.close?.();
    }
  }
}
