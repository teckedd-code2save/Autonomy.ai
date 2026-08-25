export class ComputeService {
  constructor({ modalProvider }) {
    this.modalProvider = modalProvider;
  }

  async execute(request) {
    if (!request || !Array.isArray(request.command) || request.command.length === 0) {
      throw new Error("command must be a non-empty array");
    }
    if ((request.timeoutMs ?? 60_000) > 300_000) {
      throw new Error("Gate 0 limits execution to 5 minutes");
    }

    // Gate 0 intentionally routes only to Modal.
    return this.modalProvider.execute({
      image: request.image ?? "python:3.13-slim",
      command: request.command,
      timeoutMs: request.timeoutMs ?? 60_000,
      gpu: request.gpu ?? undefined,
    });
  }
}
