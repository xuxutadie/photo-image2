FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js auth.js index.html ./
COPY 图标素材 ./图标素材
RUN mkdir -p /app/user_templates
ENV NODE_ENV=production
ENV REQUIRE_DATABASE=true
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
