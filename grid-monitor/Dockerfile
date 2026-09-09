FROM node:20-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY server.js ./
COPY lib/ ./lib/
COPY tools/ ./tools/
COPY data/network-supply-points.csv ./data/network-supply-points.csv
EXPOSE 3000
CMD ["node", "server.js"]
