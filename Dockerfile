FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server ./server
COPY --chown=node:node packages ./packages
COPY --chown=node:node web ./web
COPY --chown=node:node LICENSE ./LICENSE
USER node
EXPOSE 3000
CMD ["node", "server/start.mjs"]
