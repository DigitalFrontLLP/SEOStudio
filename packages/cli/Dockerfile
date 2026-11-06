# seostudio agent: runs the scheduled crawls of your SEOStudio projects from this server.
# Build:  docker build -t seostudio-agent .
# Run:    docker run -d --restart unless-stopped -e SEOSTUDIO_API_KEY -e SEOSTUDIO_PROJECTS seostudio-agent
FROM node:24-slim

ARG SEOSTUDIO_VERSION=latest

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    SEOSTUDIO_CONFIG_DIR=/app/config

RUN npm install --global "seostudio@${SEOSTUDIO_VERSION}" \
    && npm cache clean --force \
    && mkdir -p /app \
    && chown node:node /app

USER node
WORKDIR /app

ENTRYPOINT ["seostudio"]
CMD ["agent"]
