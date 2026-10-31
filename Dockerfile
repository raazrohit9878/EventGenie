FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY index.html styles.css app.js ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8000
CMD ["npm", "start"]
