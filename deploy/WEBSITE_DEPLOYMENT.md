# Website Deployment

This runbook deploys the SPLITBRIEF website to production at
`https://splitbrief.b4r7.dev`. The website is a static Vite build. Only the
owner runs the deploy.

## What is deployed and how

- One Docker image: `ghcr.io/b4r7x/splitbrief-website`. nginx serves the static
  build on port 8080 as a non-root user.
- `deploy/website.Dockerfile` builds the site and copies it into the image. The
  build context is the repository root, because the build reads `docs/` and
  `CHANGELOG.md` next to `website/`.
- `deploy/website-nginx.conf` holds the serving rules: 301 to the trailing-slash
  form, 301 from `…/index.html` to the directory, a real 404 with the `404.html`
  body, long cache for `/assets/`, revalidation for everything else, and the
  security headers from `deploy/nginx-security-headers.conf`.
- The workflow `.github/workflows/deploy-website.yml` (Actions name
  **Deploy Website**) builds the image, pushes the tag `<sha>`, scans the pushed
  digest with Trivy, and moves the tag `:prod` to that scanned digest.
- A Coolify **Docker Image** resource pulls `:prod`. The workflow calls its
  webhook. Coolify does not build anything.
- Coolify has no registry credentials, so the GHCR package must be public.
  Before the workflow moves `:prod`, it pulls the image manifest anonymously.
  If that pull fails, the run stops and `:prod` does not move.
- Coolify's Traefik terminates TLS and routes the domain to port 8080.
- Each build writes a unique build identity, `<sha>-<run id>-<run attempt>`, to
  `/build-id`. The digest record holds the digest and this identity.
- The workflow then checks the live site. It first waits until `/build-id`
  serves the identity of the promoted image. A rebuild of the live commit gets
  a new identity, so the old container cannot pass this check. If a check
  fails, the workflow moves `:prod` back to the previous digest and calls the
  webhook again.
- Before it moves `:prod`, the workflow reads the current `:prod` digest. A
  missing `:prod` means a first deploy. Any other read error stops the run, and
  `:prod` does not move.

`website/site.json` is the one home of the public origin. The workflow reads the
origin from it with `jq -r .origin website/site.json`. nginx is host-agnostic
and names no domain.

## Prerequisites

- A VPS with Coolify installed.
- DNS: an `A` record and an `AAAA` record for `splitbrief.b4r7.dev` that point
  to the VPS. Add the same records for `www.splitbrief.b4r7.dev`.
- TLS: Coolify's Traefik gets the certificate from Let's Encrypt. Port 80 must
  be open for the HTTP-01 challenge.
- Firewall: allow `80/tcp` and `443/tcp` from the internet. Keep SSH for
  management only. Do not publish container port 8080 on the host.

## Owner setup, in order

1. **GitHub environment.** Create the environment `production` in the
   repository settings. Add yourself as a required reviewer.
2. **Coolify API token.** In Coolify, create an API token that can deploy.
   Store it as the `production` environment secret `COOLIFY_TOKEN`.
3. **Coolify resource.** Create a Docker Image resource with these settings.
   Do not start it yet, because the image does not exist yet.
   - Image: `ghcr.io/b4r7x/splitbrief-website:prod`
   - Port: `8080`
   - Domain: `https://splitbrief.b4r7.dev`
   - Health check path: `/`
   - Health check host: `127.0.0.1`
   - Auto Deploy: off
4. **Health check host.** Use `127.0.0.1`, not `localhost`. Coolify runs the
   health check inside the container with `wget`. On Alpine, `localhost` can
   resolve to `::1` first, and nginx listens on IPv4 only. With `localhost`,
   diffgazer saw every deploy marked unhealthy and rolled back. The image's own
   `HEALTHCHECK` also uses `127.0.0.1`.
5. **www alias.** Add `https://www.splitbrief.b4r7.dev` to the same resource.
   Set Coolify's redirect option to redirect www to non-www (a permanent
   redirect). Do this in Coolify, not in nginx.
6. **Webhook secret.** Coolify shows the deploy webhook URL only after the
   resource exists. Copy it into the `production` environment secret
   `COOLIFY_WEBHOOK_WEBSITE`.
7. **Artifact retention.** Keep the repository artifact retention at 90 days.
   It caps the digest records, and with them the rollback window.
8. **First run.** Run the workflow (see below). Wait until the job
   **Build and Scan Website** finishes. That job pushes the first image, so the
   GHCR package `splitbrief-website` now exists. GitHub creates a new package
   as private.
9. **Make the package public.** GitHub now asks for the `production` approval.
   Do not approve it yet. Open the package from the **Packages** list of the
   repository, then open **Package settings**. Set the visibility to
   **Public**. Make sure that the package is linked to
   the repository `b4r7x/splitbrief`.
10. **Approve the first deploy.** Approve the `production` environment. The
    workflow pulls the image anonymously before it moves `:prod`. If the
    package is still private, the run fails with a "not publicly pullable"
    error and `:prod` does not move. Make the package public, then run the
    workflow again.
11. **Check the resource.** The workflow calls the Coolify webhook. The
    webhook deploys the resource, and that deploy starts it. The live checks
    then wait up to 5 minutes for the site. Make sure that Coolify shows the
    resource as running. If the live checks failed because the resource did
    not start, start it in Coolify, then run the workflow again.

You can also confirm the visibility by hand with an anonymous pull:

```sh
docker logout ghcr.io
docker pull ghcr.io/b4r7x/splitbrief-website:prod
```

## Run the deploy

1. Open **Actions → Deploy Website → Run workflow**.
2. Select the branch `main`. The workflow refuses every other ref.
3. Type `deploy` in `confirm_production`.
4. Leave `image_sha` empty to deploy `main` HEAD.
5. Approve the `production` environment when GitHub asks.

The workflow refuses a SHA that has no green `CI` push run on `main`. The `CI`
job `website` must also be green in that run. `CI` cancels a running push run
when a newer push arrives, so an older SHA can have no completed run. Deploy the
newer SHA in that case.

Trivy blocks the promotion on a HIGH or CRITICAL finding. Follow
[Update the base images](#update-the-base-images), then run the workflow again.

## Local check before a deploy

Run the check from the repository root. The build needs network access for
`npm ci`.

```sh
scripts/verify-website-image.sh
```

The script builds the image, runs it on a free local port and removes the
container when it stops. It prints one `PASS` or `FAIL` line per check and
exits non-zero if a check fails. It checks these points:

- `/`, `/docs/`, a guide, `sitemap.xml`, `robots.txt`, `llms.txt`,
  `favicon.svg` and `social.png` answer 200.
- A missing page and the unpublished guide `/docs/dogfooding/` answer 404 with
  the 404 page. The 404 page links its assets from `/assets/`, and they load.
- `/docs`, `/index.html`, `/docs/index.html` and a guide without its slash
  answer 301 with a relative `Location`.
- A 200, a 301 and a 404 response carry all six security headers.
- HTML revalidates on every request. Hashed assets cache for one year as
  `immutable`.
- nginx compresses HTML with gzip.
- The CSP allows scripts from the origin only. The landing page has a JSON-LD
  block and no other inline script.

Set `WEBSITE_IMAGE_TAG` to use another image tag. Set `SKIP_BUILD=1` to check
an image that you built before. A local build has no `build-id`, because only
the workflow writes `website/public/build-id`.

## Update the base images

The Dockerfile pins both base images by digest. Every rebuild of one commit
gets the same OS packages. To take OS security fixes, bump the pinned digests.
This is the normal path:

1. Find the newest digest of the runtime base. Keep the same nginx major and
   minor line if you can:

   ```sh
   docker buildx imagetools inspect nginx:<version>-alpine-slim
   ```

2. Do the same for the builder base `node:<version>-alpine<alpine>`.
3. Put the new tags and digests into the `FROM` lines of
   `deploy/website.Dockerfile`.
4. Run `scripts/verify-website-image.sh`.
5. Scan the image that the script built:

   ```sh
   trivy image --severity HIGH,CRITICAL --exit-code 1 splitbrief-website:verify
   ```

   Without a local Trivy, use the `aquasec/trivy` container:

   ```sh
   docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
     aquasec/trivy image --severity HIGH,CRITICAL --exit-code 1 splitbrief-website:verify
   ```

6. Merge the change to `main` and run the deploy.

Sometimes no upstream image has the fix yet. Then pin the fixed package in the
runtime stage, for that package only:

```dockerfile
RUN apk add --no-cache --upgrade '<package>=<fixed-version>'
```

Take the fixed version from the Trivy report. Build, run the check and scan as
in steps 4 and 5. Remove the line at the next base bump that includes the fix.
If Alpine drops the pinned version, the build fails. Then bump the base or the
pin. Never add an unpinned `apk upgrade`.

The Dockerfile has one such line now. It pins `pcre2=10.49-r0` for
CVE-2026-103111. Delete it when the pinned nginx base ships pcre2 10.49 or
later.

## Production verification

The workflow runs these checks itself. Run them by hand after a deploy or a
rollback:

```sh
O=https://splitbrief.b4r7.dev
curl -s -o /dev/null -w '%{http_code}\n' $O/                                   # 200
curl -sI $O/docs | grep -iE '^(HTTP|location)'                                 # 301, /docs/
curl -sI $O/index.html | grep -iE '^(HTTP|location)'                           # 301, /
curl -s -o /dev/null -w '%{http_code}\n' $O/docs/getting-started/              # 200
curl -s -o /dev/null -w '%{http_code}\n' $O/this-page-does-not-exist/          # 404
curl -s -o /dev/null -w '%{http_code}\n' $O/docs/dogfooding/                   # 404
curl -sI $O/docs/getting-started | grep -iE '^(HTTP|location)'                 # 301, /docs/getting-started/
curl -sI $O/docs/getting-started/index.html | grep -iE '^(HTTP|location)'      # 301, /docs/getting-started/
curl -s -o /dev/null -w '%{http_code}\n' $O/robots.txt                         # 200
curl -s -o /dev/null -w '%{http_code}\n' $O/sitemap.xml                        # 200
curl -s $O/build-id                                                            # <commit SHA>-<run id>-<run attempt> of the deployed build
```

## Search engines

The owner does these steps once, after the first deploy:

1. Verify the domain in Google Search Console. Use the DNS TXT method, so no
   verification file goes into the image.
2. Submit the sitemap `https://splitbrief.b4r7.dev/sitemap.xml` in Search
   Console.
3. Open Bing Webmaster Tools. Import the site from Google Search Console, or
   verify it with a DNS TXT record. Submit the same sitemap.

## Rollback

1. Find the full 40-character SHA of the last good deploy. Its deploy run is in
   the **Deploy Website** history.
2. Run the workflow again from `main`, type `deploy`, and set `image_sha` to
   that SHA.

The rollback does not build. It reads the scanned digest and the build identity
that an earlier run of `deploy-website.yml` recorded for that SHA, moves `:prod`
to the digest, calls the webhook and runs the live checks. The live checks wait
for that build identity. Only the record of a successful deploy run
from `main` is eligible. The newest such run wins. A failed or cancelled run
can hold a record, but its image never passed the live checks, so the rollback
ignores it. The digest record lives for 90 days. After that the rollback fails,
and you must deploy a fresh build instead. The rollback SHA must also have a
green `CI` run.

A failed live check rolls back automatically. The first deploy has no previous
`:prod`, so a failed first deploy has nothing to roll back to. The workflow
reports this and leaves `:prod` on the failed image until the next deploy.

## Move to another server

1. Install Coolify on the new VPS.
2. Create the Docker Image resource with the same settings as above.
3. Put the new resource's webhook URL into `COOLIFY_WEBHOOK_WEBSITE`. Replace
   `COOLIFY_TOKEN` if the new Coolify uses a new token.
4. Change the `A` and `AAAA` records to the new VPS.
5. Run the workflow, or start the resource in Coolify.

The image does not change. It names no host.

## Change the origin

1. Edit `origin` in `website/site.json`. The build and the workflow read it
   from there. Merge the change to `main`.
2. Create the DNS records for the new host.
3. Change the domain of the Coolify resource.
4. Run the workflow. It builds with the new origin and checks the new host.
5. Submit the new sitemap to the search engines.

## Publish the npm link

`npm.published` in `website/site.json` controls the install copy. While it is
`false`, the landing's npm tab says that the first npm release is coming and
links the GitHub repository. It shows no `npm install` command.

When it is `true`, the npm tab shows `npm install -g splitbrief` and links
`https://www.npmjs.com/package/splitbrief`. The JSON-LD and `llms.txt` also
name that URL.

After the first npm release, set it to `true`, merge the change to `main` and
run the workflow. Do not set it earlier: a visitor would get an install error.
