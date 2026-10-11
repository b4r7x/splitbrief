# Build context: the repository root. The website build reads repository files
# outside website/ (the published guides under docs/ and CHANGELOG.md), because
# website/build/catalog.ts resolves the repository root as website/../.

# Stage 1: Build the static site
FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder

WORKDIR /repo/website

# Dependencies first so a content-only change reuses this layer. The lockfile
# carries the @rolldown/binding-linux-x64-musl binding, so no install script or
# native toolchain is needed on Alpine.
COPY website/package.json website/package-lock.json ./
RUN npm ci --ignore-scripts

COPY website/ ./
COPY docs/ /repo/docs/
COPY CHANGELOG.md /repo/

RUN npm run build

# Stage 2: Serve the static files
# alpine-slim, not alpine: the full variant ships modules we never load
# (image-filter, xslt, geoip, njs) and the library chain they pull in. alpine-slim
# is nginx + busybox only: less to patch and less to attack.
#
# Both base images are pinned by digest. OS security fixes arrive by bumping the
# pinned digests (deploy/WEBSITE_DEPLOYMENT.md, "Update the base images"). Never
# add an unpinned `apk upgrade`.
FROM nginx:1.31.5-alpine-slim@sha256:3b171d7224b669faa3cc2137fea0a65301791df1ec1f271ebd2a2b7461f7fade AS runtime

# CVE-2026-103111: no nginx alpine-slim image ships the fixed pcre2 yet. This
# pins the fixed package, so the build gives the same result each time. If
# Alpine drops this version, the build fails loudly instead of drifting. Delete
# this line when the pinned nginx base ships pcre2 >= 10.49.
RUN apk add --no-cache --upgrade 'pcre2=10.49-r0'

COPY --from=builder /repo/website/dist /usr/share/nginx/html
COPY deploy/nginx-security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY deploy/website-nginx.conf /etc/nginx/conf.d/default.conf

RUN nginx -t

RUN rm -f /usr/share/nginx/html/50x.html \
 && chown -R nginx:nginx /usr/share/nginx/html \
 && chown -R nginx:nginx /var/cache/nginx /var/log/nginx \
 && touch /var/run/nginx.pid && chown nginx:nginx /var/run/nginx.pid

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/ || exit 1
