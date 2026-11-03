# Edith: site, app, API and the demo provider in one process.
# Secrets come from the host's environment, never from this image. Mount persistent storage at /data.
FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev && mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4030 \
    DATA_DIR=/data \
    STATIC_DIR=web/dist \
    TRUST_PROXY=1
VOLUME /data
EXPOSE 4030
USER node
CMD ["node", "src/api.mjs"]
