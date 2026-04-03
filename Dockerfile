FROM node:20-alpine

WORKDIR /app

# Copy server dependencies and install
COPY server/package*.json ./server/
RUN cd server && npm ci

# Copy entire project (server + frontend files)
COPY . .

EXPOSE 3000

WORKDIR /app/server
CMD ["node", "server.js"]
