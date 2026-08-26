import { PROVIDER_CREDENTIAL_FIELDS, newConnectionId } from "./connections.js";
import { ValidationError } from "./model.js";

// ConnectionService is the operator-facing write path:
//
//   validate credential against the real provider
//     -> persist into the secret store (never the record store)
//     -> activate in the runtime overlay broker (no restart needed)
//     -> record opaque ProviderConnection metadata
//
// If validation fails, nothing is stored.
export class ConnectionService {
  constructor({ providers, secretStore, recordStore, overlayBroker }) {
    this.providers = providers;
    this.secretStore = secretStore;
    this.recordStore = recordStore;
    this.overlayBroker = overlayBroker;
  }

  list() {
    return this.recordStore.list();
  }

  async connect(providerId, credential, { namespace } = {}) {
    const provider = this.providers.get(providerId);
    const fields = PROVIDER_CREDENTIAL_FIELDS[providerId];
    if (!provider || !fields) {
      throw new ValidationError(`unknown provider: ${providerId}`);
    }

    for (const field of fields) {
      if (!credential?.[field.field] || typeof credential[field.field] !== "string") {
        throw new ValidationError(`missing credential field: ${field.field}`);
      }
    }

    // 1. Validate against the real provider using a one-shot broker, so the
    //    candidate credential never passes through the shared broker state.
    //    The live provider instance is cloned, not mutated.
    const candidateBroker = {
      getModalCredentials: async () => ({ tokenId: credential.tokenId, tokenSecret: credential.tokenSecret }),
      getHuggingFaceCredentials: async () => ({ token: credential.token }),
    };
    const testProvider = new provider.constructor({
      ...provider,
      credentialBroker: candidateBroker,
      namespace: providerId === "huggingface" ? (namespace ?? provider.namespace) : provider.namespace,
    });

    let connection;
    try {
      connection = await testProvider.testConnection();
    } catch (error) {
      const failure = new Error(
        `credential validation failed for ${providerId}: ${error?.message ?? "unknown error"}`,
      );
      failure.name = "ConnectionValidationError";
      throw failure;
    }

    // 2. Persist the credential into the secret store only.
    const { credentialRef } = await this.secretStore.set(providerId, credential, {
      ...(providerId === "huggingface" && namespace ? { HF_NAMESPACE: namespace } : {}),
    });

    // 3. Activate immediately.
    this.overlayBroker.setRuntime(providerId, credential);
    if (providerId === "huggingface" && namespace) {
      provider.namespace = namespace;
    }

    // 4. Record opaque metadata.
    const now = new Date().toISOString();
    const record = this.recordStore.upsert({
      id: newConnectionId(),
      provider: providerId,
      status: "active",
      credentialRef,
      account: connection.account ?? connection.appId ?? null,
      namespace: providerId === "huggingface" ? (namespace ?? null) : null,
      secretStore: this.secretStore.kind,
      createdAt: now,
      lastTestedAt: now,
    });

    return { connection: record, test: connection };
  }

  async disconnect(providerId) {
    this.overlayBroker.clearRuntime(providerId);
    await this.secretStore.delete(providerId);
    const removed = this.recordStore.remove(providerId);
    return { provider: providerId, disconnected: removed };
  }
}
