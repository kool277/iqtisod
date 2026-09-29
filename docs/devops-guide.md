# DevOps guide

Moliya is a static single-page app. The server only serves files. User data never reaches it, so there is no database to run, no secrets to manage, and nothing to back up on the server side. The operational work is building, releasing, deploying, keeping the website address stable, and making sure every release still opens every vault and backup ever made.

## Build

| Item | Value |
| --- | --- |
| Runtime | Node.js 22.12+ (`.nvmrc`; CI uses the same file) |
| Install | `npm ci --ignore-scripts` (requires the committed `package-lock.json`; no locked package needs an install script) |
| Build | `npm run build`, which runs `tsc --noEmit` then `vite build` |
| Output | `dist/` |
| Base path | `./` (relative), so the same build works at a domain root or under a sub-path |
| Routing | Hash-based (`#/app`), so no rewrite or 404 fallback rules are needed |

`dist/` contains:

- `index.html`, whose `<head>` starts with the charset, `<meta name="referrer" content="no-referrer">`, and the Content Security Policy `<meta>` tag, in that order (production builds only), so the policy applies before any script.
- `version.json` with `version`, `commit`, and `builtAt`. Running apps poll it to detect a new deployment.
- `coi-config.js` and `coi-serviceworker.js`. `coi-config.js` runs first: it records whether the page is framed, creates the Trusted Types `default` policy, and configures the service worker.
- `assets/` with hashed files. The first screen loads only the app entry (about 110 KB, 35 KB gzipped) and React (about 260 KB, 80 KB gzipped). Pages, Chart.js (about 180 KB), and SQLite (about 210 KB of JavaScript plus an 870 KB WebAssembly binary, about 400 KB gzipped) load on demand. Serve `.wasm` as `application/wasm`; GitHub Pages and most hosts do this already.

Builds are reproducible: the build date comes from `SOURCE_DATE_EPOCH` or the commit date, not the clock, and the commit comes from `git` (or `GITHUB_SHA`).

## Runtime requirements

- **HTTPS is mandatory.** The Web Crypto API only works in a secure context. `http://localhost` is the only non-HTTPS exception.
- **Cross-origin isolation headers are optional.** The current design keeps SQLite in memory on the main thread, which works without them. They are sent anyway so a future worker or OPFS build keeps working:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`

  Vite sets them for `npm run dev` and `npm run preview`. On hosts that cannot set headers, `coi-serviceworker.js` adds them in the browser. That causes one automatic reload on a visitor's first load. If the host already sends both headers, the service worker does not register. Inside a frame it never registers.
- **Web Locks and IndexedDB** are required. Every supported browser has both.
- The app loads nothing from third-party origins.

## Content Security Policy

The production `index.html` carries this policy (defined as `CONTENT_SECURITY_POLICY` in `vite.config.ts`):

```text
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'none';
child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; upgrade-insecure-requests;
require-trusted-types-for 'script'; trusted-types default
```

- Everything not listed is refused (`default-src 'none'`). The app loads nothing from other origins.
- `'wasm-unsafe-eval'` is needed to compile SQLite. There is no inline exception for scripts or styles. Style properties that React and Chart.js set from JavaScript are allowed; `<style>` blocks and `style="…"` attributes in HTML are not.
- `data:` images are stored receipts. Receipts must be PNG, JPEG, WebP, or GIF; SVG is refused on upload.
- **Trusted Types.** `require-trusted-types-for 'script'` makes the browser refuse strings passed to HTML and script sinks (`innerHTML`, `eval`-like calls, script URLs) unless a policy approves them. `public/coi-config.js` creates the only policy, `default`, which implements just `createScriptURL` and approves only the URL of `coi-serviceworker.js`. React never needs it. Adding code or a library that writes HTML strings breaks the production build's end-to-end tests rather than opening a hole.
- **Framing.** A `<meta>` policy cannot set `frame-ancestors`, `report-uri`, or `sandbox`. So `coi-config.js` records whether the page is inside a frame, and `src/main.tsx` then shows only "For your safety, Moliya does not run inside another page." with a link to open Moliya in its own tab. The app, the vault, and the service worker never start in a frame. If the host can send headers, also send the policy as a header with `frame-ancestors 'none'` added (see [Security headers](#security-headers)).
- The development server has no policy, so Vite's hot reload works. `npm run test:e2e:preview` (and CI) run the browser tests against the production build and fail on any policy or Trusted Types violation.

## Continuous integration and deployment (GitHub Pages)

All actions are pinned to full commit SHAs with the release tag in a comment. Dependabot keeps them current, and waits 7 days after a release before proposing it (`cooldown: default-days: 7`, for npm and Actions), so a hijacked release has time to be found and pulled first.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | Pull requests, pushes to branches other than `main`, called by the other workflows | `npm ci --ignore-scripts`, `npm audit signatures` (registry signatures and provenance), typecheck, unit tests, `npm audit --omit=dev --audit-level=high` (plus an advisory full `npm audit`), build (uploads `dist` as an artifact), Playwright against the production preview, dependency review on pull requests |
| `deploy.yml` | Push to `main`, manual | Runs `ci.yml`, then publishes the tested `dist` artifact to `gh-pages` in the `production` environment |
| `release.yml` | Tag `vX.Y.Z` | Runs `ci.yml`, checks the tag equals `package.json`'s version, packages `moliya-X.Y.Z.zip` and `SHA256SUMS`, attests build provenance, and creates a GitHub release with the notes from `CHANGELOG.md` |
| `codeql.yml` | Push and pull request to `main`, weekly | CodeQL `security-extended` for JavaScript and TypeScript |

The deploy only publishes the exact files CI tested. A failing check stops it, and the last good version stays online. Deploys never cancel each other half-way (`concurrency: pages`, `cancel-in-progress: false`).

### One-time GitHub settings

The repository is `kool277/iqtisod`. These settings cannot be committed and must be set by an owner:

1. **Settings → Pages → Build and deployment**: **Deploy from a branch**, branch `gh-pages`, folder `/ (root)`. Enable **Enforce HTTPS**. (If you ever switch to "GitHub Actions" as the source, change `deploy.yml` to `actions/deploy-pages` at the same time, or the site stops updating.)
2. **Settings → Environments → New environment** `production`. Optionally add required reviewers and restrict deployment branches to `main`, so a person approves each production deploy.
3. **Settings → Actions → General → Workflow permissions**: keep **Read repository contents** as the default. Each job asks for the write permissions it needs.
4. **Settings → Rules → Rulesets** (or Branches) for `main`: require a pull request, require the status checks **Typecheck, unit tests, audit, build**, **End-to-end tests (production preview)**, and **Analyze (javascript-typescript)**, block force pushes and deletion.
5. A tag ruleset for `v*`: restrict creation to maintainers and block deletion and updates, so a released tag always points at the same code.
6. **Settings → Code security**: enable Dependabot alerts, Dependabot security updates, secret scanning with push protection, and code scanning (the CodeQL workflow uploads results once enabled).
7. In the `main` ruleset, also enable **Require review from Code Owners**. `.github/CODEOWNERS` assigns `@kool277` to key handling and storage (`src/crypto/`, `src/db/`), the auth, grant, user, account, and sign-in check services, the password policy, throttle, safe JSON, and limits modules, `public/`, `index.html`, `vite.config.ts`, the recovery tool, `tests/fixtures/`, `package-lock.json`, and `.github/`.
8. Private vulnerability reporting: **Settings → Code security → Private vulnerability reporting → Enable**, so the link in [SECURITY.md](../SECURITY.md) works.

A local `iqtisod/` directory, if present, is a nested git clone rather than project code. `.gitignore` excludes it; do not add it back to the index, because a gitlink without `.gitmodules` breaks `actions/checkout`.

### Custom domain

A dedicated domain (a subdomain such as `moliya.example.com` is simplest) gives Moliya its own origin; see [Origin and storage isolation](#origin-and-storage-isolation). Read that section before switching: users' vaults do not follow them to a new address.

1. **Verify the domain for the account first**, so nobody else can point it at their own Pages site: in your GitHub profile's **Settings → Pages → Verified domains**, choose **Add a domain**, create the `TXT` record GitHub shows (`_github-pages-challenge-kool277.example.com`), and choose **Verify**. Keep the record in DNS.
2. **DNS**: create a `CNAME` record from `moliya.example.com` to `kool277.github.io`. (An apex domain needs GitHub's `A` and `AAAA` records instead; a subdomain avoids that.) Do not use wildcard records.
3. **Repository**: in `kool277/iqtisod` **Settings → Pages → Custom domain**, enter `moliya.example.com` and save. Also add `cname: moliya.example.com` under `with:` in the publish step of `deploy.yml`. The deploy replaces the whole `gh-pages` branch (`keep_files: false`), so without this line the next deploy deletes the `CNAME` file and the domain stops working.
4. **HTTPS**: wait until GitHub has issued the certificate (the Pages settings say so; it can take up to an hour), then tick **Enforce HTTPS**.
5. **Update the environment URL** in `deploy.yml` (`environment.url`) and any links in the docs.
6. **Optional: Cloudflare in front**, to send real security headers (GitHub Pages cannot):
   1. Add the domain to Cloudflare and keep the `CNAME` record **DNS only** until step 4 above is done, because GitHub's certificate check needs to reach GitHub directly.
   2. Switch the record to **Proxied**.
   3. **SSL/TLS → Overview**: set the mode to **Full (strict)**. Never use Flexible: it would fetch the site from GitHub over plain HTTP. Turn on **Always Use HTTPS**.
   4. Add the headers from [Security headers](#security-headers) as a Transform Rule.
   5. Leave off every feature that injects scripts or rewrites pages: Rocket Loader, Email Address Obfuscation, automatic Web Analytics injection, Zaraz, and HTML minification. The policy and Trusted Types block injected scripts, and the app may break.
   6. Do not add a "Cache Everything" rule for `index.html` or `version.json`, so releases are picked up.

   If GitHub later reports a certificate problem for the domain, switch the record to **DNS only** until GitHub has renewed it, then back to **Proxied**.
7. **Move the data.** Keep the old address online. Ask every Admin to download a backup at the old address and import it at the new one, and check it there before anyone makes changes. Vaults at the old address stay where they are; nothing moves on its own.

## Security headers

GitHub Pages sends none of these. Send them wherever the host allows (Cloudflare, Netlify, Nginx), on every response:

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | the policy from [Content Security Policy](#content-security-policy) plus `; frame-ancestors 'none'` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Embedder-Policy` | `require-corp` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `Permissions-Policy` | `accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()` |
| `X-Frame-Options` | `DENY` (for old browsers that ignore `frame-ancestors`) |

Keep the header policy identical to the `<meta>` policy apart from `frame-ancestors`. Browsers apply both, so a stricter header silently breaks the app, and a looser one adds nothing. When you change `CONTENT_SECURITY_POLICY` in `vite.config.ts`, change the header too. Once the host sends the two isolation headers, `coi-serviceworker.js` no longer registers.

**Cloudflare Transform Rule** (**Rules → Transform Rules → Modify Response Header → Create rule**):

- When: custom filter expression `(http.host eq "moliya.example.com")`.
- Then: one **Set static** operation per header:

```text
Content-Security-Policy      default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; upgrade-insecure-requests; require-trusted-types-for 'script'; trusted-types default; frame-ancestors 'none'
Cross-Origin-Opener-Policy   same-origin
Cross-Origin-Embedder-Policy require-corp
X-Content-Type-Options       nosniff
Referrer-Policy              no-referrer
Permissions-Policy           accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()
X-Frame-Options              DENY
```

**`_headers` file** (Cloudflare Pages and Netlify): see [Other hosts](#other-hosts).

Check the result with `curl -sI https://moliya.example.com/ | grep -iE 'content-security|cross-origin|x-content|referrer|permissions|x-frame'`, then open the app and look for policy errors in the browser console.

## Versioning and releases

Moliya follows [Semantic Versioning](https://semver.org/). The app version lives in `package.json` and appears in the sidebar, on the sign-in screens, in Settings → About, in `version.json`, and inside every backup and stored record. Data formats have their own version numbers, specified in [data-format.md](data-format.md); an app release does not always change them.

| Change | Version bump |
| --- | --- |
| A new data format, schema migration, or anything a user must know about before upgrading | Minor (major if older data would stop opening, which the compatibility rules forbid) |
| New features without format changes | Minor |
| Fixes only | Patch |

### Release checklist

1. On a branch `release/vX.Y.Z`, set `version` in `package.json` (and run `npm install` so the lock file matches).
2. Move the `Unreleased` notes in `CHANGELOG.md` into `## [X.Y.Z] - YYYY-MM-DD` and update the links at the bottom.
3. If a data format changed, follow [Changing a format](data-format.md#changing-a-format): new fixtures generated by the new release, `MANIFEST.json`, `SHA256SUMS`, and the specification.
4. Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e:preview`. Check that `dist/index.html` starts with the charset, referrer, and policy `<meta>` tags, and that the policy matches the headers on any host that sends them.
5. If the release changes security behaviour, update [SECURITY.md](../SECURITY.md) (supported versions) and the threat model in the [developer guide](developer-guide.md#threat-model).
6. Merge to `main` through a pull request. `deploy.yml` publishes the site.
7. Tag the merge commit and push the tag:

   ```bash
   git tag -a vX.Y.Z -m "Moliya X.Y.Z"
   git push origin vX.Y.Z
   ```

   `release.yml` builds the release assets. Keep the zip: it is the exact build that can open the data of that version offline.

Running apps notice the new `version.json` within 30 minutes, or when the tab becomes visible again, and show "A new version of Moliya is available". Reload locks the vault first, so unsaved work is saved.

### Rollback

- Code: `git revert` the bad commit on `main` and push; the normal pipeline redeploys. In an emergency, re-run **Deploy GitHub Pages** for the last good commit from the Actions tab, or reset `gh-pages` to its previous commit.
- **Data after a format change.** If a release upgraded users' vaults (for example 1.0.0 → 1.1.0, 1.1.0 → 1.2.0 with schema 3, or 1.2.0 → 1.3.0 with schema 4), rolling the code back does not roll the data back. An older build refuses a newer record with the message "This vault was saved by a newer version of Moliya" instead of damaging it. It shows only that message: it cannot sign anyone in, open the Backup page, or import over the stored vault. Users are not stuck, but they need the newer build to get their data out first:
  - each upgraded browser keeps the original record as an archive (Backup page → Earlier copies in this browser → **Before upgrade**). Download it with the newer build before rolling back. The older build imports it on its setup screen once the site's data has been cleared (which also deletes the stored vault and its archives). Anything done in the newer release, such as private safes created in 1.2.0 or people who joined with a 1.3.0 invite, is not in it;
  - backups taken before the upgrade still open in the older build;
  - `npm run decrypt` opens any version.

  Prefer rolling forward with a fix. For 1.3.0 in particular, a rollback also loses every invite, reset code, and sign-in check set up since the upgrade.

## Origin and storage isolation

This is the most important operational topic, because it decides whether users can reach their data.

- **A vault belongs to an origin** (scheme, host, and port). IndexedDB is per origin. Moving from `kool277.github.io` to a custom domain, or changing a port, gives users an empty app. Their vault still exists at the old address. Announce a move ahead of time, and ask admins to export a backup at the old address and import it at the new one. Keep the old address online during the transition.
- **Paths do not isolate.** `https://kool277.github.io/iqtisod/` shares its origin with every other GitHub Pages site of the account: the user site (a repository named `kool277.github.io`) and the project site of every other repository with Pages turned on. JavaScript on any of those pages can read the stored ciphertext and the plaintext emails, delete or replace the vault and its earlier copies, unregister the isolation service worker, and script open Moliya windows. A user site can also register a service worker for the whole origin, which would then control Moliya's pages. The data stays encrypted, but for real use, host Moliya on its **own origin**: a custom domain or subdomain that serves nothing else (see [Custom domain](#custom-domain)).
- **Until then, keep no other Pages sites on `kool277`.** Do not create a user site or turn on Pages for any other repository of the account, and check **Settings → Pages** of existing repositories now and then. Also note that giving a user site a custom domain moves project sites without their own domain under it, which changes Moliya's origin and hides every vault.
- **Browsers may evict storage.** The app requests persistent storage after sign-in. Safari still deletes script-written data after 7 days without a visit for sites not added to the Home Screen. Backups are the real protection; the app reminds admins when the last backup is older than 7 days.
- **Redeploying never touches user data.** Data lives only in users' browsers. Rolling back the code does not roll back or delete anyone's vault.

## Long-term data compatibility

Every release must open every vault and backup ever produced, for at least ten years. This is enforced in CI, not by convention:

- `tests/fixtures/backups/` holds real backups made by each release, pinned by `SHA256SUMS`. The unit tests open each one for every person and compare records, totals, and the audit chain to the expected values. Changing or deleting a fixture fails the build.
- The tests also fail if any supported backup, record, or schema version has no fixture.
- `upgrade.spec.ts` plants a real 1.0.0 IndexedDB record in a browser and upgrades it through the UI.
- `tools/moliya-decrypt.mjs` opens any backup with Node.js alone, even if the website is gone.

See [data-format.md](data-format.md) for the full specification and the rules for changing a format.

## Other hosts

Any static host works. Upload `dist/` and, where possible, send the [security headers](#security-headers).

**Netlify**: add `public/_headers` (Vite copies it into `dist/`):

```text
/*
  Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; upgrade-insecure-requests; require-trusted-types-for 'script'; trusted-types default; frame-ancestors 'none'
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()
  X-Frame-Options: DENY
/version.json
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
```

Cloudflare Pages uses the same `_headers` format.

**Nginx**: a `location` that sets any `add_header` drops all headers set at the `server` level, so keep the security headers in one file and include it everywhere.

```nginx
# /etc/nginx/snippets/moliya-headers.conf
add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; upgrade-insecure-requests; require-trusted-types-for 'script'; trusted-types default; frame-ancestors 'none'" always;
add_header Cross-Origin-Opener-Policy same-origin always;
add_header Cross-Origin-Embedder-Policy require-corp always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy no-referrer always;
add_header Permissions-Policy "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()" always;
add_header X-Frame-Options DENY always;
```

```nginx
server {
  listen 443 ssl;
  server_name moliya.example.com;
  root /var/www/moliya;

  include snippets/moliya-headers.conf;

  location /assets/ {
    include snippets/moliya-headers.conf;
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  location ~ ^/(index\.html|version\.json|coi-serviceworker\.js|coi-config\.js)$ {
    include snippets/moliya-headers.conf;
    add_header Cache-Control "no-cache";
  }
}
```

Files in `assets/` have content hashes and can be cached forever. Keep `index.html`, `version.json`, and the two `coi-*` scripts uncached or short-lived, so new releases are picked up. GitHub Pages caches everything for about 10 minutes, so a release can take that long to reach everyone; the update check fetches `version.json` with `cache: 'no-store'`.

## Monitoring and logging

There is no server-side logging, analytics, or error reporting, by design. Adding any would break the "nothing leaves the device" promise and must be opt-in and documented if ever added. Useful checks:

- The Actions tab and the Security tab (CodeQL, Dependabot) for failures and alerts.
- An uptime check that fetches `version.json`, expects `200`, and compares `version` with the latest tag.
- After each deploy, open the site, create a throwaway vault in a private window, add one record, and check the version in Settings → About.

## Dependency maintenance

- Dependabot opens grouped pull requests weekly for npm and GitHub Actions, for releases at least 7 days old. CI must pass before merging, and changes to `package-lock.json` or `.github/` need the code owner's review. Security updates are not delayed by the cooldown.
- CI installs with `--ignore-scripts`. If a new dependency really needs an install script, say so in the pull request and change CI deliberately.
- `npm audit signatures` fails the build if a package's registry signature or provenance attestation does not verify.
- `@sqlite.org/sqlite-wasm` is pinned to an exact version (`3.53.4-build1`). Upgrade deliberately; the fixture tests verify that every stored database still opens and migrates.
- `public/coi-serviceworker.js` is a vendored copy of coi-serviceworker v0.1.7 (MIT). Update it by downloading the new file from the upstream repository.
- Playwright browsers must match the Playwright version. CI installs them on every run.

## Security checklist

- [ ] Served only over HTTPS. Enforce HTTPS in Pages settings.
- [ ] Hosted on a dedicated origin for production use, with the domain verified for the account.
- [ ] Until then, no other GitHub Pages site (user or project) on `kool277`.
- [ ] If a proxy or host can send headers: the full policy with `frame-ancestors 'none'`, COOP, COEP, `nosniff`, `Referrer-Policy`, and `Permissions-Policy` sent on every response, and Cloudflare in **Full (strict)** mode with script-injecting features off.
- [ ] Branch and tag rulesets as described in [One-time GitHub settings](#one-time-github-settings), with **Require review from Code Owners** on `main`. `.github/CODEOWNERS` covers key handling, storage, auth, grants, users, account, the sign-in check, limits, `public/`, `index.html`, `vite.config.ts`, the recovery tool, fixtures, the lock file, and `.github/`. (`src/services/safe.service.ts` is not in it; review it with the same care.)
- [ ] `production` environment in place; workflow default permissions read-only.
- [ ] Code scanning, Dependabot alerts, secret scanning, and private vulnerability reporting enabled.
- [ ] CI installs with `--ignore-scripts` and runs `npm audit signatures`; Dependabot cooldown in place.
- [ ] No analytics or third-party scripts added to `index.html`; the policy and Trusted Types block them anyway.
- [ ] The production end-to-end run reports no policy or Trusted Types violations.
- [ ] Release zips and `SHA256SUMS` kept for every version.
