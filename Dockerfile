FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json tsconfig.json ./
RUN bun install

COPY src ./src

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/data.sqlite

EXPOSE 3000

CMD ["bun", "run", "start"]
