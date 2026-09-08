FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data
# Container networking cannot satisfy the direct-local adapter's literal
# loopback-only boundary. Keep this optional image on the explicit compatibility
# backend; the normal registration-free product path is the host/Desktop app.
ENV MULTICONTEXT_BACKEND=librechat MULTICONTEXT_HOST=0.0.0.0 MULTICONTEXT_PORT=4317 MULTICONTEXT_DATA_FILE=/app/data/state.json
EXPOSE 4317
CMD ["node","src/server.js"]
