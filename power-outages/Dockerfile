FROM node:20-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY server.js ./
COPY icp-data.js ./
COPY powerco-regions.js ./
COPY region-mapper.js ./
COPY not-feasible-regions.js ./
COPY scrapers/ ./scrapers/
COPY data/ ./data/
EXPOSE 3000
CMD ["node", "server.js"]
