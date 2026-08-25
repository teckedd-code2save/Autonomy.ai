import { InfisicalSDK } from "@infisical/sdk";

// Credential broker contract: providers fetch secrets late, only after policy
// and routing have selected them. `has*Credentials()` is a metadata-level
// check used by the router to build the candidate set; it never exposes
// secret values.

export class EnvironmentCredentialBroker {
  constructor(env = process.env) {
    this.env = env;
  }

  hasModalCredentials() {
    return Boolean(this.env.MODAL_TOKEN_ID && this.env.MODAL_TOKEN_SECRET);
  }

  hasHuggingFaceCredentials() {
    return Boolean(this.env.HF_TOKEN);
  }

  async getModalCredentials() {
    const tokenId = this.env.MODAL_TOKEN_ID;
    const tokenSecret = this.env.MODAL_TOKEN_SECRET;

    if (!tokenId || !tokenSecret) {
      throw new Error("Modal credentials are incomplete");
    }

    return { tokenId, tokenSecret };
  }

  async getHuggingFaceCredentials() {
    const token = this.env.HF_TOKEN;

    if (!token) {
      throw new Error("Hugging Face credentials are incomplete");
    }

    return { token };
  }
}

export class InfisicalCredentialBroker {
  #client;
  #config;
  #loginPromise;

  constructor(config, client = null) {
    this.#config = config;
    this.#client = client ?? new InfisicalSDK({ siteUrl: config.siteUrl });
  }

  // With Infisical, the router treats a provider as a candidate when the
  // broker itself is configured; a missing secret surfaces as a classified
  // provider failure and the router fails over. That failover is the product.
  #hasClientCredentials() {
    return Boolean(this.#config.clientId && this.#config.clientSecret && this.#config.projectId);
  }

  hasModalCredentials() {
    return this.#hasClientCredentials();
  }

  hasHuggingFaceCredentials() {
    return this.#hasClientCredentials();
  }

  async #ensureLoggedIn() {
    const { clientId, clientSecret, projectId } = this.#config;
    if (!clientId || !clientSecret || !projectId) {
      throw new Error(
        "Infisical Universal Auth is not configured. Inject provider credentials directly or configure Infisical client credentials.",
      );
    }

    if (!this.#loginPromise) {
      this.#loginPromise = this.#client.auth().universalAuth.login({
        clientId,
        clientSecret,
      });
    }

    await this.#loginPromise;
  }

  async #getSecret(secretName, secretPath) {
    await this.#ensureLoggedIn();
    const result = await this.#client.secrets().getSecret({
      environment: this.#config.environment,
      projectId: this.#config.projectId,
      secretName,
      secretPath,
      viewSecretValue: true,
    });
    return result.secretValue;
  }

  async getModalCredentials() {
    const [tokenId, tokenSecret] = await Promise.all([
      this.#getSecret("MODAL_TOKEN_ID", this.#config.secretPath ?? "/providers/modal"),
      this.#getSecret("MODAL_TOKEN_SECRET", this.#config.secretPath ?? "/providers/modal"),
    ]);

    if (!tokenId || !tokenSecret) {
      throw new Error("Modal credentials are incomplete");
    }

    return { tokenId, tokenSecret };
  }

  async getHuggingFaceCredentials() {
    const token = await this.#getSecret("HF_TOKEN", this.#config.hfSecretPath ?? "/providers/huggingface");

    if (!token) {
      throw new Error("Hugging Face credentials are incomplete");
    }

    return { token };
  }
}

export function createCredentialBroker({ env = process.env, infisicalConfig }) {
  const hasInjected = (env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET) || env.HF_TOKEN;
  if (hasInjected) {
    return new EnvironmentCredentialBroker(env);
  }

  return new InfisicalCredentialBroker(infisicalConfig);
}
