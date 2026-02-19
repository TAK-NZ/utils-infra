FROM node:20-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY server.js ./
COPY scrapers/ ./scrapers/
EXPOSE 3000
CMD ["node", "server.js"]
