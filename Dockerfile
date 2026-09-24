FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY shared ./shared
COPY lib ./lib
COPY server.js ./

RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
