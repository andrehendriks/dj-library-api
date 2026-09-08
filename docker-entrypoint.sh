#!/bin/sh
set -eu

echo "Applying Prisma schema to ${DATABASE_URL}..."
./node_modules/.bin/prisma db push --skip-generate

if [ "${SEED_DATABASE:-false}" = "true" ]; then
  echo "Seeding database (idempotent)..."
  node dist/prisma/seed.js
fi

exec "$@"
