import { ExecutionStatus, newExecutionId } from "./model.js";

const TERMINAL = new Set([
  ExecutionStatus.SUCCEEDED,
  ExecutionStatus.FAILED,
  ExecutionStatus.STOPPED,
]);

// In-memory execution record store. One record per provider attempt; failover
// provenance is expressed through parentExecutionId + routeReason so a single
// agent request can map to an attempt chain.
export class ExecutionRegistry {
  #records = new Map();
  #stopHandles = new Map();

  create({ workload, provider = null, parentExecutionId = null, routeReason = null }) {
    const now = new Date().toISOString();
    const record = {
      id: newExecutionId(),
      status: ExecutionStatus.QUEUED,
      provider,
      providerExecutionId: null,
      parentExecutionId,
      routeReason,
      workload: {
        kind: workload.kind,
        image: workload.image,
        command: workload.command,
        gpu: workload.gpu ?? null,
        timeoutMs: workload.timeoutMs,
      },
      failureCode: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.#records.set(record.id, record);
    return record;
  }

  get(id) {
    return this.#records.get(id) ?? null;
  }

  list() {
    return [...this.#records.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  transition(id, status, patch = {}) {
    const record = this.#records.get(id);
    if (!record) return null;
    if (TERMINAL.has(record.status) && record.status !== status) return record;

    record.status = status;
    Object.assign(record, patch);
    if ((status === ExecutionStatus.RUNNING || status === ExecutionStatus.STARTING) && !record.startedAt) {
      record.startedAt = new Date().toISOString();
    }
    if (TERMINAL.has(status)) {
      record.finishedAt = new Date().toISOString();
      this.#stopHandles.delete(id);
    }
    return record;
  }

  registerStopHandle(id, stop) {
    this.#stopHandles.set(id, stop);
  }

  async stop(id) {
    const record = this.#records.get(id);
    if (!record) return null;
    if (TERMINAL.has(record.status)) return record;

    const stop = this.#stopHandles.get(id);
    if (stop) {
      await stop().catch(() => {});
    }
    return this.transition(id, ExecutionStatus.STOPPED);
  }
}
