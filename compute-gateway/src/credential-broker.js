import { InfisicalSDK } from "@infisical/sdk";

export class InfisicalCredentialBroker {
  #client;
  #config;
  #loginPromise;

  constructor(config, client = null) {
    this.#config = config;
    this.#client = client ?? new InfisicalSDK({ siteUrl: config.siteUrl });
  }

  async #ensureLoggedIn() {
    if (!this.#loginPromise) {
      this.#loginPromise = this.#client.auth().universalAuth.login({
        clientId: this.#config.clientId,
        clientSecret: this.#config.clientSecret,
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

    if (!tokenId || !tokenSecret) throw new Error("Modal credentials are incomplete");
    return { tokenId, tokenSecret };
  }
}
