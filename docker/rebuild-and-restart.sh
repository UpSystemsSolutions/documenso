#!/bin/sh
set -x

# Build the application
npm run build

# Find and kill the existing node server
pkill -f "node build/server/main.js"

# Start the server again
HOSTNAME=0.0.0.0 PORT=3000 node build/server/main.js
