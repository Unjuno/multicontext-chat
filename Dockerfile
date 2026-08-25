FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data
ENV MULTICONTEXT_HOST=0.0.0.0 MULTICONTEXT_PORT=4317 MULTICONTEXT_DATA_FILE=/app/data/state.json
EXPOSE 4317
CMD ["node","src/server.js"]
