#!/bin/sh
set -x

# Run database migrations
npx prisma migrate deploy --schema ../../packages/prisma/schema.prisma

# Build the application if it doesn't exist
if [ ! -f "build/server/main.js" ]; then
  npm run build
fi

# Start the development server in the background
npm run dev -- --host 0.0.0.0 --port 3001 &

# Start the production server for assets
HOSTNAME=0.0.0.0 PORT=3000 node build/server/main.js

## Install chokidar if not already installed
#npm install --save-dev chokidar
#
## Start the watch script
#node /app/docker/watch.js

