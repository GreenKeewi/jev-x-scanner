FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public

ENV NODE_ENV=production

EXPOSE 3200

CMD ["node", "server/server.js"]
