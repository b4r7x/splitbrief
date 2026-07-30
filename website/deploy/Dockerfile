FROM node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ARG SITE_URL
ENV SITE_URL=${SITE_URL}
RUN npm run build:container
RUN test -s dist/client/index.html \
    && test -s dist/client/404.html \
    && test -s dist/client/api/search \
    && test -s dist/client/og.png \
    && test -s dist/client/llms.txt \
    && test -s dist/client/sitemap.xml \
    && test -s dist/client/robots.txt \
    && test -s dist/client/THIRD_PARTY_NOTICES.txt \
    && test -s dist/client/docs/getting-started/introduction.md \
    && test -s dist/nginx-csp.conf
RUN find dist/client -type f \( \
      -name '*.js' \
      -o -name '*.css' \
      -o -name '*.html' \
      -o -name '*.svg' \
      -o -name '*.json' \
      -o -name '*.txt' \
      -o -name '*.xml' \
      -o -name '*.md' \
      -o -path '*/api/search' \
    \) -exec sh -c \
      'for file do gzip -9 -k -f "$file"; touch -r "$file" "$file.gz"; done' sh {} +

FROM nginx:1.29.8-alpine3.23@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/nginx-csp.conf /etc/nginx/conf.d/splitbrief-csp.inc
COPY --from=build /app/dist/client /usr/share/nginx/html

EXPOSE 80
