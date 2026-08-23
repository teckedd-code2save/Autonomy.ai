export function loadConfig(env = process.env) {
  const required = [
    "AGENT_API_KEY",
    "INFISICAL_CLIENT_ID",
    "INFISICAL_CLIENT_SECRET",
    "INFISICAL_PROJECT_ID",
  ];

  for (const key of required) {
    if (!env[key]) throw new Error(`Missing required environment variable: ${key}`);
  }

  return {
    port: Number(env.PORT ?? 4000),
    agentApiKey: env.AGENT_API_KEY,
    infisical: {
      siteUrl: env.INFISICAL_SITE_URL ?? "https://app.infisical.com",
      clientId: env.INFISICAL_CLIENT_ID,
      clientSecret: env.INFISICAL_CLIENT_SECRET,
      projectId: env.INFISICAL_PROJECT_ID,
      environment: env.INFISICAL_ENVIRONMENT ?? "dev",
      secretPath: env.INFISICAL_SECRET_PATH ?? "/providers/modal",
    },
    modal: {
      appName: env.MODAL_APP_NAME ?? "compute-gateway-poc",
    },
  };
}
