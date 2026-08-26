FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src/ ./src/
COPY scripts/ ./scripts/

EXPOSE 4000

# Required at runtime:
#   AGENT_API_KEY        agent surface auth
#   OPERATOR_API_KEY     operator/connect surface auth (omit to disable)
# plus ONE credential source:
#   MODAL_TOKEN_ID/SECRET, HF_TOKEN (direct injection), or
#   INFISICAL_CLIENT_ID/SECRET/PROJECT_ID (broker)
CMD ["node", "src/server.js"]
