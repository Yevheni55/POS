FROM node:20-alpine

# postgresql-client gives us pg_dump for the daily 04:00 backup job that
# server.js schedules. Version-pinned to match the postgres:16-alpine
# database image so dump format is fully compatible. gzip is in base
# alpine but listed explicitly to document the backup pipeline's deps.
RUN apk add --no-cache postgresql16-client gzip

WORKDIR /app

# Copy server dependencies and install
COPY server/package*.json ./server/
RUN cd server && npm ci

# Copy entire project (server + frontend files)
COPY . .

EXPOSE 3080

WORKDIR /app/server
CMD ["node", "server.js"]
