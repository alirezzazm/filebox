FROM node:22-alpine

WORKDIR /app

# نصب وابستگی‌ها
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# کد برنامه
COPY server.js ./
COPY public ./public

# پوشه داده (با volume از بیرون mount می‌شود)
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.js"]
