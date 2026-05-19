# 🐳 Stage 1: Install Dependencies
FROM node:20-alpine AS base
WORKDIR /app
COPY package.json bun.lock* ./
RUN npm install --frozen-lockfile || npm install

# 🐳 Stage 2: Build Next.js Application
FROM base AS builder
WORKDIR /app
COPY . .
# Safe build-time environment variable to block background scraper from starting during build phase
ENV IS_BUILD=true
RUN npm run build

# 🐳 Stage 3: Production Runner Container
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Copy built code and minimal assets
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/next.config.ts ./next.config.ts

EXPOSE 3000

# Start production server
CMD ["npm", "run", "start"]
