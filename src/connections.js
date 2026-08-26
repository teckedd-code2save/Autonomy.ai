import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { InfisicalSDK } from "@infisical/sdk";

// The connection plane. Operator-facing only: a human connects a provider
// account once, the credential goes straight into a secret store, and the
// gateway keeps only an opaque ProviderConnection record. Agents never see
// this surface — they consume the capability, not the credential.

// --- credential shape per provider ------------------------------------------

export const PROVIDER_CREDENTIAL_FIELDS = {
  modal: [
    { field: "tokenId", envVar: "MODAL_TOKEN_ID", secretName: "MODAL_TOKEN_ID" },
    { field: "tokenSecret", envVar: "MODAL_TOKEN_SECRET", secretName: "MODAL_TOKEN_SECRET" },
  ],
  huggingface: [
    { field: "token", envVar: "HF_TOKEN", secretName: "HF_TOKEN" },
  ],
};

export function newConnectionId() {
  return `conn_${crypto.randomBytes(6).toString("hex")}`;
}

// --- runtime overlay broker ---------------------------------------------------

// Precedence: runtime overlay (connected via UI/CLI this boot) -> primary
// broker (env injection or Infisical). Connecting a provider takes effect
// immediately, without a restart.
export class OverlayCredentialBroker {
  constructor(primary) {
    this.primary = primary;
    this.overlay = new Map();
  }

  setRuntime(providerId, credential) {
    this.overlay.set(providerId, credential);
  }

  clearRuntime(providerId) {
    this.overlay.delete(providerId);
  }

  hasModalCredentials() {
    return this.overlay.has("modal") || Boolean(this.primary?.hasModalCredentials?.());
  }

  hasHuggingFaceCredentials() {
    return this.overlay.has("huggingface") || Boolean(this.primary?.hasHuggingFaceCredentials?.());
  }

  async getModalCredentials() {
    const hit = this.overlay.get("modal");
    if (hit) return { tokenId: hit.tokenId, tokenSecret: hit.tokenSecret };
    return this.primary.getModalCredentials();
  }

  async getHuggingFaceCredentials() {
    const hit = this.overlay.get("huggingface");
    if (hit) return { token: hit.token };
    return this.primary.getHuggingFaceCredentials();
  }
}

// --- secret stores (write path) -----------------------------------------------

// Dev store: persists credentials into the local .env file. The .env file is
// gitignored; this is the local-dev path only.
export class EnvFileSecretStore {
  constructor(envFile = ".env") {
    this.envFile = envFile;
    this.kind = "env-file";
  }

  async set(providerId, credential, extra = {}) {
    const fields = PROVIDER_CREDENTIAL_FIELDS[providerId];
    if (!fields) throw new Error(`unknown provider: ${providerId}`);

    const updates = new Map(fields.map((f) => [f.envVar, credential[f.field]]));
    for (const [key, value] of Object.entries(extra)) updates.set(key, value);

    const lines = fs.existsSync(this.envFile)
      ? fs.readFileSync(this.envFile, "utf8").split("\n")
      : [];
    const seen = new Set();
    const next = lines.map((line) => {
      const match = line.match(/^([A-Z0-9_]+)=/);
      if (match && updates.has(match[1])) {
        seen.add(match[1]);
        return `${match[1]}=${updates.get(match[1])}`;
      }
      return line;
    });
    for (const [key, value] of updates) {
      if (!seen.has(key)) next.push(`${key}=${value}`);
    }

    fs.writeFileSync(this.envFile, next.join("\n").replace(/\n{3,}/g, "\n\n"));
    return { credentialRef: `env:${fields.map((f) => f.envVar).join(",")}` };
  }

  async delete(providerId) {
    const fields = PROVIDER_CREDENTIAL_FIELDS[providerId];
    if (!fields || !fs.existsSync(this.envFile)) return;
    const drop = new Set(fields.map((f) => f.envVar));
    const next = fs.readFileSync(this.envFile, "utf8")
      .split("\n")
      .filter((line) => !drop.has(line.match(/^([A-Z0-9_]+)=/)?.[1]));
    fs.writeFileSync(this.envFile, next.join("\n"));
  }
}

// Production store: credentials go to Infisical under /providers/<id>; the
// gateway never persists them locally.
export class InfisicalSecretStore {
  constructor(config, client = null) {
    this.config = config;
    this.client = client ?? new InfisicalSDK({ siteUrl: config.siteUrl });
    this.loginPromise = null;
    this.kind = "infisical";
  }

  async #ensureLoggedIn() {
    const { clientId, clientSecret, projectId } = this.config;
    if (!clientId || !clientSecret || !projectId) {
      throw new Error("Infisical Universal Auth is not configured");
    }
    if (!this.loginPromise) {
      this.loginPromise = this.client.auth().universalAuth.login({ clientId, clientSecret });
    }
    await this.loginPromise;
  }

  async set(providerId, credential) {
    const fields = PROVIDER_CREDENTIAL_FIELDS[providerId];
    if (!fields) throw new Error(`unknown provider: ${providerId}`);
    await this.#ensureLoggedIn();

    const secretPath = providerId === "huggingface"
      ? (this.config.hfSecretPath ?? "/providers/huggingface")
      : (this.config.secretPath ?? "/providers/modal");

    for (const field of fields) {
      const base = {
        environment: this.config.environment,
        projectId: this.config.projectId,
        secretName: field.secretName,
        secretValue: credential[field.field],
        secretPath,
      };
      try {
        await this.client.secrets().createSecret(base);
      } catch (error) {
        // Already exists -> update in place.
        await this.client.secrets().updateSecret(base);
      }
    }
    return { credentialRef: `infisical:${secretPath}` };
  }

  async delete(providerId) {
    const fields = PROVIDER_CREDENTIAL_FIELDS[providerId];
    if (!fields) return;
    await this.#ensureLoggedIn();
    const secretPath = providerId === "huggingface"
      ? (this.config.hfSecretPath ?? "/providers/huggingface")
      : (this.config.secretPath ?? "/providers/modal");
    for (const field of fields) {
      await this.client.secrets().deleteSecret({
        environment: this.config.environment,
        projectId: this.config.projectId,
        secretName: field.secretName,
        secretPath,
      }).catch(() => {});
    }
  }
}

// --- opaque connection records --------------------------------------------------

// Records hold metadata only. Secret values never touch this store.
export class ConnectionRecordStore {
  constructor(file) {
    this.file = file;
  }

  #read() {
    if (!fs.existsSync(this.file)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
  }

  #write(records) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(records, null, 2));
  }

  list() {
    return this.#read();
  }

  upsert(record) {
    const records = this.#read().filter((r) => r.provider !== record.provider);
    records.push(record);
    this.#write(records);
    return record;
  }

  remove(providerId) {
    const records = this.#read();
    const next = records.filter((r) => r.provider !== providerId);
    this.#write(next);
    return records.length !== next.length;
  }
}
