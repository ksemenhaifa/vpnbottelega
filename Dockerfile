# Стрижи · Водоснабжение — образ без зависимостей
FROM node:20-alpine

WORKDIR /app
COPY . .
RUN rm -rf .git .github deploy Dockerfile docker-compose.yml \
 && addgroup -S app && adduser -S app -G app \
 && mkdir -p /data && chown -R app:app /app /data

USER app
ENV PORT=8080 HOST=0.0.0.0 DATA_DIR=/data TRUST_PROXY=1
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/readings').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.mjs"]
