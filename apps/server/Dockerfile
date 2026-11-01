# Libraria server + web client. Build from the repository root:
#   docker build -f apps/server/Dockerfile -t libraria .
#   docker run -p 8080:8080 -v libraria-data:/data libraria
ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-slim AS build
WORKDIR /src
RUN npm install -g pnpm@10.33.2
COPY . .
RUN pnpm install --frozen-lockfile
# The web client is optional: build it when the workspace has one.
RUN if [ -d apps/web ]; then pnpm --filter @libraria/web build; fi
RUN pnpm --filter @libraria/server build \
 && pnpm --filter @libraria/server deploy --prod --legacy /out/server \
 && mkdir -p /out/web \
 && if [ -d apps/web/dist ]; then cp -r apps/web/dist /out/web/dist; fi

FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production \
    LIBRARIA_DATA_DIR=/data \
    LIBRARIA_PORT=8080
WORKDIR /app
# The server looks for the client at ../web/dist relative to its package.
COPY --from=build /out/server /app/server
COPY --from=build /out/web /app/web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "/app/server/dist/index.js"]
