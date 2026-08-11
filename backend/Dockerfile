FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Installs are persisted here — mount a volume on this path in Dokploy.
ENV MS_STORE_PATH=/data/accounts.json
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/index.js"]
