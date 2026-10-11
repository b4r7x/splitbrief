#!/usr/bin/env bash
# Pre-deploy check of the website image: build it, run it on a free local port,
# and check the serving contract that production depends on (status codes, the
# 404 page, relative redirects, security headers, caching, gzip, CSP).
#
# Run from anywhere; the build context is the repository root.
#   scripts/verify-website-image.sh
# Environment:
#   WEBSITE_IMAGE_TAG  image tag to build and run (default splitbrief-website:verify)
#   SKIP_BUILD=1       run the tag that already exists instead of building it
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tag="${WEBSITE_IMAGE_TAG:-splitbrief-website:verify}"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "Building ${tag}"
  docker build --platform linux/amd64 -f "${repo_root}/deploy/website.Dockerfile" -t "${tag}" "${repo_root}"
fi

container=""
headers_file="$(mktemp)"
body_file="$(mktemp)"
cleanup() {
  if [ -n "${container}" ]; then
    docker rm -f "${container}" > /dev/null 2>&1 || true
  fi
  rm -f "${headers_file}" "${body_file}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

container="$(docker run -d --platform linux/amd64 -p 127.0.0.1::8080 "${tag}")"
host_port="$(docker port "${container}" 8080/tcp | head -n 1)"
base="http://127.0.0.1:${host_port##*:}"

deadline=$((SECONDS + 30))
until curl -fsS -o /dev/null --max-time 2 "${base}/" 2> /dev/null; do
  if [ "${SECONDS}" -ge "${deadline}" ]; then
    echo "The container did not answer ${base}/ within 30s." >&2
    docker logs "${container}" >&2 || true
    exit 1
  fi
  sleep 1
done
echo "Serving ${tag} at ${base}"

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  failures=$((failures + 1))
}

# One GET, redirects never followed. Extra curl arguments follow the path. It
# sets status and headers (CR stripped) and writes the body to body_file. Any
# HTTP status is a response; a transport error, such as a truncated body, fails
# the check.
fetch() {
  local path="$1"
  shift
  if ! status="$(curl -sS --max-time 10 -D "${headers_file}" -o "${body_file}" \
    -w '%{http_code}' "$@" "${base}${path}")"; then
    fail "GET ${path}: transport error"
    return 1
  fi
  headers="$(tr -d '\r' < "${headers_file}")"
}

# First value of a header, matched case-insensitively.
header_value() {
  printf '%s\n' "$1" | awk -v name="$2" '
    tolower(substr($0, 1, length(name) + 1)) == tolower(name) ":" {
      value = substr($0, length(name) + 2)
      sub(/^[ \t]+/, "", value)
      sub(/[ \t]+$/, "", value)
      print value
      exit
    }'
}

expect_status() {
  local path="$1" want="$2"
  fetch "${path}" || return 1
  if [ "${status}" = "${want}" ]; then
    pass "GET ${path} -> ${status}"
  else
    fail "GET ${path} -> ${status}, expected ${want}"
    return 1
  fi
}

for path in / /docs/ /docs/getting-started/ /sitemap.xml /robots.txt /llms.txt /favicon.svg /social.png; do
  expect_status "${path}" 200 || true
done

# A missing page and an unpublished guide both get a real 404 with the 404 page.
# The page links its assets root-absolute, so it renders at any depth.
for path in /this-page-does-not-exist/ /docs/dogfooding/; do
  expect_status "${path}" 404 || continue
  body="$(< "${body_file}")"
  if grep -qF '<title>Page not found · SPLITBRIEF</title>' <<< "${body}"; then
    pass "GET ${path} body has the 404 title"
  else
    fail "GET ${path} body has no '<title>Page not found · SPLITBRIEF</title>'"
  fi
  if grep -qF 'class="not-found-page"' <<< "${body}"; then
    pass "GET ${path} body has class=\"not-found-page\""
  else
    fail "GET ${path} body has no class=\"not-found-page\""
  fi
  relative_refs="$(grep -oE '(href|src)="(\./|\.\./)*assets/[^"]*"' <<< "${body}" || true)"
  absolute_ref="$(grep -oE '(href|src)="/assets/[^"]+"' <<< "${body}" | head -n 1 || true)"
  if [ -n "${relative_refs}" ]; then
    fail "GET ${path} 404 page has relative asset URLs: $(head -n 1 <<< "${relative_refs}")"
  elif [ -z "${absolute_ref}" ]; then
    fail "GET ${path} 404 page has no root-absolute /assets/ URL"
  else
    asset="${absolute_ref#*=\"}"
    asset="${asset%\"}"
    expect_status "${asset}" 200 || true
  fi
done

# Traefik terminates TLS in front of nginx, so a redirect must stay relative.
expect_redirect() {
  local path="$1" want="$2" location
  fetch "${path}" || return 0
  location="$(header_value "${headers}" Location)"
  if [ "${status}" != "301" ]; then
    fail "GET ${path} -> ${status}, expected 301"
  elif [[ "${location}" != /* || "${location}" == //* ]]; then
    fail "GET ${path} -> 301 with a non-relative Location '${location}'"
  elif [ "${location}" != "${want}" ]; then
    fail "GET ${path} -> 301 ${location}, expected ${want}"
  else
    pass "GET ${path} -> 301 ${location}"
  fi
}

expect_redirect /docs /docs/
expect_redirect /index.html /
expect_redirect /docs/index.html /docs/
expect_redirect /docs/getting-started /docs/getting-started/

for path in / /docs /this-page-does-not-exist/; do
  fetch "${path}" || continue
  for check in \
    'X-Content-Type-Options=nosniff' \
    'X-Frame-Options=DENY' \
    'Referrer-Policy=' \
    'Strict-Transport-Security=' \
    'Content-Security-Policy=' \
    'Permissions-Policy='; do
    name="${check%%=*}"
    want="${check#*=}"
    value="$(header_value "${headers}" "${name}")"
    if [ -z "${value}" ]; then
      fail "GET ${path} (${status}) has no ${name}"
    elif [ -n "${want}" ] && [ "$(tr '[:upper:]' '[:lower:]' <<< "${value}")" != "$(tr '[:upper:]' '[:lower:]' <<< "${want}")" ]; then
      fail "GET ${path} (${status}) ${name} is '${value}', expected '${want}'"
    else
      pass "GET ${path} (${status}) ${name}: ${value}"
    fi
  done
done

for path in / /docs/getting-started/; do
  fetch "${path}" || continue
  value="$(header_value "${headers}" Cache-Control)"
  if [ "${value}" = "public, max-age=0, must-revalidate" ]; then
    pass "GET ${path} Cache-Control: ${value}"
  else
    fail "GET ${path} Cache-Control is '${value}', expected 'public, max-age=0, must-revalidate'"
  fi
done

landing=""
csp=""
if fetch /; then
  landing="$(< "${body_file}")"
  csp="$(header_value "${headers}" Content-Security-Policy)"
fi
asset="$(grep -oE '(href|src)="(\./|/)?assets/[^"]+"' <<< "${landing}" | head -n 1 || true)"
if [ -z "${asset}" ]; then
  fail "GET / links no hashed asset under assets/"
else
  asset="${asset#*=\"}"
  asset="${asset%\"}"
  asset="/assets/${asset#*assets/}"
  if fetch "${asset}"; then
    value="$(header_value "${headers}" Cache-Control)"
    if [[ "${value}" == *max-age=31536000* && "${value}" == *immutable* ]]; then
      pass "GET ${asset} Cache-Control: ${value}"
    else
      fail "GET ${asset} Cache-Control is '${value}', expected max-age=31536000 and immutable"
    fi
  fi
fi

# nginx does not compress HEAD responses, so this is a GET. --compressed asks
# for gzip and decodes the body, so a broken gzip stream is a transport error.
for path in / /docs/getting-started/; do
  fetch "${path}" --compressed || continue
  value="$(header_value "${headers}" Content-Encoding)"
  if [ "${value}" = "gzip" ]; then
    pass "GET ${path} Content-Encoding: gzip"
  else
    fail "GET ${path} Content-Encoding is '${value}', expected gzip"
  fi
done

# script-src 'self' blocks inline scripts. A JSON-LD block is data, not a script,
# so the CSP neither runs nor blocks it; any other inline script would break.
script_src="$(grep -oE "script-src[^;]*" <<< "${csp}" | head -n 1 || true)"
if [ "${script_src}" = "script-src 'self'" ]; then
  pass "CSP ${script_src}"
else
  fail "CSP script-src is '${script_src}', expected \"script-src 'self'\""
fi
landing_flat="$(tr '\n' ' ' <<< "${landing}")"
script_tags="$(grep -oiE '<script[^>]*>' <<< "${landing_flat}" || true)"
if grep -qiE 'type="application/ld\+json"' <<< "${script_tags}"; then
  pass "GET / has a <script type=\"application/ld+json\"> block"
else
  fail "GET / has no <script type=\"application/ld+json\"> block"
fi
inline_executable=0
while IFS= read -r tag_html; do
  [ -n "${tag_html}" ] || continue
  if grep -qiE '[[:space:]]src=' <<< "${tag_html}"; then
    continue
  fi
  if ! grep -qiE 'type="application/ld\+json"' <<< "${tag_html}"; then
    fail "GET / has an inline executable script: ${tag_html}"
    inline_executable=1
  fi
done <<< "${script_tags}"
if [ "${inline_executable}" -eq 0 ]; then
  pass "GET / inline scripts are JSON-LD data blocks only"
fi

if [ "${failures}" -gt 0 ]; then
  echo "${failures} check(s) failed."
  exit 1
fi
echo "All checks passed."
