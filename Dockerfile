FROM node:22-alpine

# su-exec برای انداختن امتیاز از root به node در entrypoint
RUN apk add --no-cache su-exec

WORKDIR /app

# نصب وابستگی‌ها
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# کد برنامه
COPY server.js ./
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# پوشه داده — معمولاً از هاست mount می‌شود؛ entrypoint مالکیتش را درست می‌کند
RUN mkdir -p /data && chown -R node:node /data /app

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

# به عنوان root شروع می‌شود، entrypoint بلافاصله به node می‌اندازد
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
