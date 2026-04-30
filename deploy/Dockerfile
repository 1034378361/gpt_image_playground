# ---- Build stage ----
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Production stage ----
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.docker.conf /etc/nginx/templates/default.conf.template

ENV GIP_BACKEND_UPSTREAM=http://backend:8000

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
