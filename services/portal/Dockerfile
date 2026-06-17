FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
ARG VITE_API_URL=https://api.gctrl.tech
ENV VITE_API_URL=$VITE_API_URL
# Cookieless analytics (self-hosted Umami). Website ID is public (ships in the page),
# so it's a build arg / repo variable, not a secret. Empty ID => no tracking loads.
ARG VITE_UMAMI_SCRIPT_URL=https://analytics.gctrl.tech/script.js
ENV VITE_UMAMI_SCRIPT_URL=$VITE_UMAMI_SCRIPT_URL
ARG VITE_UMAMI_WEBSITE_ID=
ENV VITE_UMAMI_WEBSITE_ID=$VITE_UMAMI_WEBSITE_ID
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
