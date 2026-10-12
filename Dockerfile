FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json server.mjs document-schema.mjs ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
