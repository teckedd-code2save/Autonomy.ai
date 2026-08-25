import { InfisicalSDK } from "@infisical/sdk";

export class EnvironmentCredentialBroker {
  constructor(env = process.env) {
    this.env = env;
  }

  async getModalCredentials() {
    const tokenId = this.env.MODAL_TOKEN_ID;
    const tokenSecret = this.env.MODAL_TOKEN_SECRET;

    if (!tokenId || !tokenSecret) {
      throw new Error("Modal credentials are incomplete");
    }

    return { tokenId, tokenSecret };
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

  async #ensureLoggedIn() {
    const { clientId, clientSecret, projectId } = this.#config;
    if (!clientId || !clientSecret || !projectId) {
      throw new Error(
        "Infisical Universal Auth is not configured. Inject MODAL_TOKEN_ID/MODAL_TOKEN_SECRET or configure Infisical client credentials.",
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

  async #getSecret(secretName) {
    await this.#ensureLoggedIn();
    const result = await this.#client.secrets().getSecret({
      environment: this.#config.environment,
      projectId: this.#config.projectId,
      secretName,
      secretPath: this.#config.secretPath,
      viewSecretValue: true,
    });
    return result.secretValue;
  }

  async getModalCredentials() {
    const [tokenId, tokenSecret] = await Promise.all([
      this.#getSecret("MODAL_TOKEN_ID"),
      this.#getSecret("MODAL_TOKEN_SECRET"),
    ]);

    if (!tokenId || !tokenSecret) {
      throw new Error("Modal credentials are incomplete");
    }

    return { tokenId, tokenSecret };
  }
}

export function createCredentialBroker({ env = process.env, infisicalConfig }) {
  if (env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET) {
    return new EnvironmentCredentialBroker(env);
  }

  return new InfisicalCredentialBroker(infisicalConfig);
}
