# Use the official Playwright image — includes Chromium and all system deps.
# Alpine cannot be used here as Chromium requires glibc.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

# Copy package files and install Node deps only (Playwright browsers already in base image)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application
COPY . .

# Non-root user (uid 1001 matches the Playwright base image's pwuser)
RUN chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 3000

# Longer start period — Chromium needs time to launch and render before health check fires
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
