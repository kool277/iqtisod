# DevOps guide

Jaybi is a static single-page app. The server only serves files. User data never reaches it, so there is no database to run, no secrets to manage, and nothing to back up on the server side. The operational work is building, releasing, deploying, keeping the website address stable, and making sure every release still opens every vault and backup ever made.

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

`dist/` does not contain exchange rates. The deploy adds `rates/` from the `fx-data` branch (see [Exchange rates](#exchange-rates)); a release zip opened on its own shows the rates panel as unavailable unless `rates/` is copied next to `index.html`.

Builds are reproducible: the build date comes from `SOURCE_DATE_EPOCH` or the commit date, not the clock, and the commit comes from `git` (or `GITHUB_SHA`).

## Runtime requirements

- **HTTPS is mandatory.** The Web Crypto API only works in a secure context. `http://localhost` is the only non-HTTPS exception.
- **Cross-origin isolation headers are optional.** The current design keeps SQLite in memory on the main thread, which works without them. They are sent anyway so a future worker or OPFS build keeps working:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`

  Vite sets them for `npm run dev` and `npm run preview`. On hosts that cannot set headers, `coi-serviceworker.js` adds them in the browser. That causes one automatic reload on a visitor's first load. If the host already sends both headers, the service worker does not register. Inside a frame it never registers.
- **Web Locks and IndexedDB** are required. Every supported browser has both.
- The app loads nothing from third-party origins. Exchange rates are read from `rates/latest.json` on the same site.

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
- `connect-src 'self'` covers `version.json` and `rates/latest.json`. Do not add the central banks' domains: the browser never calls them.
- **Trusted Types.** `require-trusted-types-for 'script'` makes the browser refuse strings passed to HTML and script sinks (`innerHTML`, `eval`-like calls, script URLs) unless a policy approves them. `public/coi-config.js` creates the only policy, `default`, which implements just `createScriptURL` and approves only the URL of `coi-serviceworker.js`. React never needs it. Adding code or a library that writes HTML strings breaks the production build's end-to-end tests rather than opening a hole.
- **Framing.** A `<meta>` policy cannot set `frame-ancestors`, `report-uri`, or `sandbox`. So `coi-config.js` records whether the page is inside a frame, and `src/main.tsx` then shows only "For your safety, Jaybi does not run inside another page." with a link to open Jaybi in its own tab. The app, the vault, and the service worker never start in a frame. If the host can send headers, also send the policy as a header with `frame-ancestors 'none'` added (see [Security headers](#security-headers)).
- The development server has no policy, so Vite's hot reload works. `npm run test:e2e:preview` (and CI) run the browser tests against the production build and fail on any policy or Trusted Types violation.

## Continuous integration and deployment (GitHub Pages)

All actions are pinned to full commit SHAs with the release tag in a comment. Dependabot keeps them current, and waits 7 days after a release before proposing it (`cooldown: default-days: 7`, for npm and Actions), so a hijacked release has time to be found and pulled first.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | Pull requests, pushes to branches other than `main`, called by the other workflows | `npm ci --ignore-scripts`, `npm audit signatures` (registry signatures and provenance), typecheck, unit tests, `npm audit --omit=dev --audit-level=high` (plus an advisory full `npm audit`), build (uploads `dist` as an artifact), Playwright against the production preview, dependency review on pull requests |
| `deploy.yml` | Push to `main`, manual | Runs `ci.yml`, then publishes the tested `dist` artifact to `gh-pages` in the `production` environment, with `CNAME` only once the custom domain is set (see [Custom domain jaybi.uz](#custom-domain-jaybiuz)) |
| `release.yml` | Tag `vX.Y.Z` | Runs `ci.yml`, checks the tag equals `package.json`'s version, packages `jaybi-X.Y.Z.zip` (releases up to 1.2.0 are named `moliya-X.Y.Z.zip`) and `SHA256SUMS`, attests build provenance, and creates a GitHub release with the notes from `CHANGELOG.md` |
| `codeql.yml` | Push and pull request to `main`, weekly | CodeQL `security-extended` for JavaScript and TypeScript |
| `fx-rates.yml` | 03:17 UTC daily and 15:47 UTC on weekdays, manual | Fetches, validates, and records official exchange rates on `fx-data`, then publishes `rates/` to `gh-pages`. See [Exchange rates](#exchange-rates) |

The `verify` job installs `sqlcipher` and `7zip` with apt so the export interop tests can open the encrypted SQLite and ZIP outputs with independent tools. Locally those tests are skipped when the programs are missing (`brew install sqlcipher sevenzip` enables them). The unit tests also use the native `better-sqlite3-multiple-ciphers` module, which carries prebuilt binaries for Linux, macOS, and Windows inside the package (`prebuilds/`), so it loads without install scripts and works with `npm ci --ignore-scripts`. It is a dev dependency and never reaches the site.

The deploy only publishes the exact files CI tested. A failing check stops it, and the last good version stays online. Deploys and rate updates never overlap or cancel each other half-way (`concurrency: pages`, `cancel-in-progress: false`).

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
9. **Exchange rates**: after the workflow reaches `main`, run **Actions → Exchange rates → Run workflow** once to create the `fx-data` branch, then re-run **Deploy GitHub Pages** (or push to `main`) so the site and the rates are published together. If rulesets cover all branches, let `github-actions[bot]` push to `fx-data` and `gh-pages` (or exclude those two branches); do not require pull requests or status checks on them. Block deletion and force pushes on `fx-data`: it is the audit trail of every published rate.

A local `iqtisod/` directory, if present, is a nested git clone rather than project code. `.gitignore` excludes it; do not add it back to the index, because a gitlink without `.gitmodules` breaks `actions/checkout`.

### Custom domain jaybi.uz

Production moves from the old address `https://kool277.github.io/iqtisod/` to `https://jaybi.uz`, which gives the app an origin of its own (see [Origin and storage isolation](#origin-and-storage-isolation)). `www.jaybi.uz` redirects to `jaybi.uz`: GitHub does this by itself when both names point at GitHub Pages and the custom domain is the apex. A custom domain on the `kool277/iqtisod` repository moves only this project; other Pages sites of the account keep their `github.io` addresses.

**Users' vaults do not follow.** IndexedDB is per origin. Once the custom domain is set, GitHub answers `https://kool277.github.io/iqtisod/` with a `301` redirect to `https://jaybi.uz`, so nobody can open the old origin in a browser any more, and the vaults stored there become unreachable (they are not deleted). That is why the cut-over order below matters. From 1.3.0 the app helps: at `kool277.github.io` it shows a moving notice on the setup, sign-in, and app screens ("Jaybi is moving to jaybi.uz. Download an encrypted backup now, then open jaybi.uz and import it."), and admins get a one-click backup download. At `jaybi.uz`, the setup screen of an empty browser points people coming from the old address to the backup import.

**How the domain is deployed.** `public/CNAME` contains `jaybi.uz`, and Vite copies it to `dist/CNAME`. When Pages publishes from a branch, a `CNAME` file on `gh-pages` *is* the custom domain setting, so publishing it too early would switch the site over at once. The step **Keep CNAME only once the custom domain is set** in `deploy.yml` therefore reads `CNAME` from `gh-pages` before publishing:

| `CNAME` on `gh-pages` | What the deploy does |
| --- | --- |
| None (the domain is not set yet) | Removes `dist/CNAME` and publishes; the site stays at the old address. The log shows a notice. |
| `jaybi.uz` (an owner saved the domain in Settings, which commits the file) | Publishes `dist/CNAME`, so `keep_files: false` never deletes the domain. |
| Anything else, or the API call fails | Fails the deploy; the last good version stays online. |

Do not also set the action's `cname:` input: the domain has exactly one source, `public/CNAME`. Any other workflow that publishes to `gh-pages` must leave the root `CNAME` alone (with `peaceiris/actions-gh-pages`, a `destination_dir` limits `keep_files: false` to that folder). The `production` environment URL follows the live address automatically.

#### Safe cut-over order

1. **Deploy this version at the old address first.** Merge 1.3.0 to `main`. The deploy log says "No custom domain on gh-pages yet". Visitors at `kool277.github.io/iqtisod/` now see the moving notice.
2. **Let users back up.** Announce the move and a date, and give every Admin time (at least two weeks is reasonable) to download a backup there. Each Admin should also import it at `jaybi.uz` as soon as it works (step 7) and check it before anyone makes changes there.
3. **Verify the domain for the account.** On GitHub, open your profile **Settings → Pages → Verified domains → Add a domain**, enter `jaybi.uz`, and add the `TXT` record it shows at the registrar (step 4): name `_github-pages-challenge-kool277`, value as shown. Choose **Verify**, and keep the record in DNS for good. A verified domain cannot be claimed by anyone else's Pages site, which is what makes it safe to point DNS at GitHub before the repository uses the domain. (GitHub's docs otherwise say to add the domain to the repository first; doing that before DNS works here would redirect every visitor to the registrar's parking page.)
4. **DNS at the registrar.** At ahost.uz open **My domains → jaybi.uz → DNS manager**. Do not use the **Domain redirect** tab: GitHub serves the site and does the `www` redirect itself.
   - Delete the existing `A` record `@` → `185.196.212.52` (ahost's parking server) and every other `A`, `AAAA`, `ALIAS`, `ANAME`, or URL/redirect record for `@` and for `www`.
   - Add these records (no wildcard records, ever):

   | Type | Name | Value |
   | --- | --- | --- |
   | `A` | `@` | `185.199.108.153` |
   | `A` | `@` | `185.199.109.153` |
   | `A` | `@` | `185.199.110.153` |
   | `A` | `@` | `185.199.111.153` |
   | `AAAA` | `@` | `2606:50c0:8000::153` |
   | `AAAA` | `@` | `2606:50c0:8001::153` |
   | `AAAA` | `@` | `2606:50c0:8002::153` |
   | `AAAA` | `@` | `2606:50c0:8003::153` |
   | `CNAME` | `www` | `kool277.github.io.` (the account's Pages host only, no repository path) |
   | `TXT` | `_github-pages-challenge-kool277` | the value from step 3 |

   These are GitHub's published Pages addresses (checked against [Managing a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site) in September 2026; check again before changing DNS). If you add a `CAA` record, it must allow `letsencrypt.org`, or GitHub cannot issue the certificate.
5. **Wait for DNS**, then check from a terminal:

   ```bash
   dig jaybi.uz +short          # exactly the four 185.199.108-111.153 addresses
   dig jaybi.uz AAAA +short     # the four 2606:50c0:800x::153 addresses
   dig www.jaybi.uz +short      # kool277.github.io. followed by Pages addresses
   dig TXT _github-pages-challenge-kool277.jaybi.uz +short
   ```

   Nothing else, and in particular not `185.196.212.52`, may appear. Changes can take up to 24 hours to reach every resolver.
6. **Set the custom domain.** In `kool277/iqtisod` **Settings → Pages → Custom domain**, enter `jaybi.uz` and choose **Save**. GitHub commits `CNAME` to `gh-pages`, runs its DNS check, and requests a certificate (up to an hour, sometimes longer). When the page says the certificate is ready, tick **Enforce HTTPS**. From this moment the old address redirects to `jaybi.uz`.
7. **Check the result:**

   ```bash
   curl -I https://jaybi.uz                      # 200, server: GitHub.com
   curl -I https://www.jaybi.uz                  # 301, location: https://jaybi.uz/
   curl -I http://jaybi.uz                       # 301 to https:// once HTTPS is enforced
   curl -I https://kool277.github.io/iqtisod/    # 301, location: https://jaybi.uz/
   ```

   Open `https://jaybi.uz`, expect one automatic reload on the first visit (the isolation service worker), import a backup in a private window, and check the version in Settings → About.
8. **Run Deploy GitHub Pages once by hand** (Actions tab, **Run workflow**) and check that its log says "Custom domain jaybi.uz is set; publishing CNAME", so later deploys cannot drop the domain.

If someone missed the move, their vault is still in their browser under the old origin. The only way back to it is to remove the custom domain in Settings for a while, which also takes `jaybi.uz` offline for everyone; the next deploy then publishes without `CNAME` again. Prefer a generous announcement period instead.

The cross-origin isolation headers keep working unchanged: `coi-serviceworker.js` is served from `jaybi.uz` like the rest of the app. Nothing in the app refers to the old host except the moving notice, which appears only when `location.hostname` is `kool277.github.io`.

#### Optional: Cloudflare in front

GitHub Pages cannot send security headers. Cloudflare can, later, without changing the app:

1. Move the domain's nameservers from ahost.uz to Cloudflare and recreate the records from step 4 as **DNS only** until GitHub has issued the certificate, because GitHub's certificate check needs to reach GitHub directly.
2. Switch the `A`, `AAAA`, and `www` records to **Proxied**.
3. **SSL/TLS → Overview**: set the mode to **Full (strict)**. Never use Flexible: it would fetch the site from GitHub over plain HTTP. Turn on **Always Use HTTPS**.
4. Add the headers from [Security headers](#security-headers) as a Transform Rule.
5. Leave off every feature that injects scripts or rewrites pages: Rocket Loader, Email Address Obfuscation, automatic Web Analytics injection, Zaraz, and HTML minification. The policy and Trusted Types block injected scripts, and the app may break.
6. Do not add a "Cache Everything" rule for `index.html` or `version.json`, so releases are picked up.

If GitHub later reports a certificate problem for the domain, switch the records to **DNS only** until GitHub has renewed it, then back to **Proxied**.

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

- When: custom filter expression `(http.host eq "jaybi.uz")`.
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

Check the result with `curl -sI https://jaybi.uz/ | grep -iE 'content-security|cross-origin|x-content|referrer|permissions|x-frame'`, then open the app and look for policy errors in the browser console.

## Exchange rates

The dashboard shows official USD rates for UZS, KRW, and ILS. They are fetched server-side by `fx-rates.yml` and served from the site itself, so the browser never contacts a central bank and the CSP stays `connect-src 'self'`. Needs no secrets or API keys.

| Source | Endpoint | Used for |
| --- | --- | --- |
| Central Bank of Uzbekistan | `https://cbu.uz/uz/arkhiv-kursov-valyut/json/` (and `json/all/<date>/` for the previous rate) | USD/UZS; fallback cross for KRW and ILS; EUR/USD cross-check |
| European Central Bank | `https://data-api.ecb.europa.eu/service/data/EXR/D.USD+KRW+ILS.EUR.SP00.A` (CSV) | USD/KRW (cross via EUR); USD/ILS fallback and cross-check |
| Bank of Israel | `https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/RER_USD_ILS` (CSV) | USD/ILS representative rate |

Schedule: the CBU publishes the next day's rate in the afternoon Tashkent time, the ECB at about 16:00 CET, and the Bank of Israel at about 15:30 Israel time. The 15:47 UTC weekday run picks up all three the same day; the 03:17 UTC daily run is a safety net. GitHub may start scheduled runs late or skip them under load, which the 2-business-day stale threshold absorbs.

Each run:

1. Clones `fx-data` (an orphan branch holding only data) or starts it.
2. `npm run rates:fetch -- --out fx-data` fetches the three sources (3 attempts each, 20-second timeout), parses them strictly, cross-checks them, and compares with the last published snapshot.
3. If the official rates changed, writes `rates/latest.json`, `rates/history/YYYY-MM-DD.json`, and the raw responses in `archive/YYYY-MM-DD/`, commits them to `fx-data`, and publishes `rates/` to `gh-pages` (only the `rates/` folder is replaced). If nothing changed, nothing is committed or published.

`deploy.yml` copies `fx-data/rates` into `dist/rates/` before each deploy, because a deploy replaces the whole `gh-pages` branch. Browsers fetch `rates/latest.json` with `cache: 'no-cache'`, verify it, and keep the last good copy in local storage.

### Failure handling

| Situation | What happens | What to do |
| --- | --- | --- |
| One source is down or returns something unparseable | The pair uses its fallback source, or keeps its previous rate and date. The snapshot is published, then the run fails with "At least one official source failed" | Nothing, if the next run is green. If it persists, check the source's page and endpoint |
| Sources disagree beyond tolerance, a rate is outside its plausible range, or all sources for a pair are down with no previous rate | The run fails and publishes nothing. The site keeps the previous rates | Read the error, compare with the central banks' pages. Fix the parser if a format changed |
| A rate moved more than 10% since the last snapshot | The run fails and publishes nothing | After confirming the move on the official page, run the workflow manually with **allow_large_moves** |
| `rates/` missing from the site (for example after resetting `gh-pages`) | The panel shows cached rates as stale, or "unavailable" for new visitors | Run the workflow manually with **republish**, or re-run the deploy |
| No `fx-data` branch yet | The deploy succeeds with a warning and without `rates/` | Run the workflow once, then redeploy |
| Scheduled runs stopped | GitHub disables schedules in public repositories after 60 days without repository activity | **Actions → Exchange rates → Enable workflow** |
| A deploy shows as cancelled while a rate run was queued | GitHub keeps one pending run per concurrency group, so a newer pending run replaces an older pending one | Re-run the cancelled workflow |

The dashboard never blocks on rates: a failed fetch shows the cached rates with a notice and a retry button, and the Stale badge appears once a rate is more than 2 business days old.

To reproduce a run locally: `npm run rates:fetch -- --out .fx-data` (live) or `npm run rates:fetch -- --out /tmp/fx --replay tests/fixtures/fx --now 2026-09-29T09:17:48.000Z` (recorded). The exit code is 0 on success, 1 on a validation or fetch failure, and 2 on bad arguments.

## Versioning and releases

Jaybi follows [Semantic Versioning](https://semver.org/). The app version lives in `package.json` and appears in the sidebar, on the sign-in screens, in Settings → About, in `version.json`, and inside every backup and stored record. Data formats have their own version numbers, specified in [data-format.md](data-format.md); an app release does not always change them.

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
   git tag -a vX.Y.Z -m "Jaybi X.Y.Z"
   git push origin vX.Y.Z
   ```

   `release.yml` builds the release assets. Keep the zip: it is the exact build that can open the data of that version offline.

Running apps notice the new `version.json` within 30 minutes, or when the tab becomes visible again, and show "A new version of Jaybi is available". Reload locks the vault first, so unsaved work is saved.

### Rollback

- Code: `git revert` the bad commit on `main` and push; the normal pipeline redeploys. In an emergency, re-run **Deploy GitHub Pages** for the last good commit from the Actions tab, or reset `gh-pages` to its previous commit.
- **Data after a format change.** If a release upgraded users' vaults (for example 1.0.0 → 1.1.0, 1.1.0 → 1.2.0 with schema 3, or 1.2.0 → 1.3.0 with schema 4), rolling the code back does not roll the data back. An older build refuses a newer record with the message "This vault was saved by a newer version of Moliya" (the app's name before 1.3.0; later builds say Jaybi) instead of damaging it. It shows only that message: it cannot sign anyone in, open the Backup page, or import over the stored vault. Users are not stuck, but they need the newer build to get their data out first:
  - each upgraded browser keeps the original record as an archive (Backup page → Earlier copies in this browser → **Before upgrade**). Download it with the newer build before rolling back. The older build imports it on its setup screen once the site's data has been cleared (which also deletes the stored vault and its archives). Anything done in the newer release, such as private safes created in 1.2.0 or people who joined with a 1.3.0 invite, is not in it;
  - backups taken before the upgrade still open in the older build;
  - `npm run decrypt` opens any version.

  Prefer rolling forward with a fix. For 1.3.0 in particular, a rollback also loses every invite, reset code, and sign-in check set up since the upgrade.

## Origin and storage isolation

This is the most important operational topic, because it decides whether users can reach their data.

- **A vault belongs to an origin** (scheme, host, and port). IndexedDB is per origin. Moving from `kool277.github.io` to a custom domain, or changing a port, gives users an empty app. Their vault still exists at the old address. Announce a move ahead of time, and ask admins to export a backup at the old address and import it at the new one. On GitHub Pages the old address redirects as soon as the custom domain is set, so the backups must happen before that; see [Custom domain jaybi.uz](#custom-domain-jaybiuz) for the order.
- **Paths do not isolate.** `https://kool277.github.io/iqtisod/` shares its origin with every other GitHub Pages site of the account: the user site (a repository named `kool277.github.io`) and the project site of every other repository with Pages turned on. JavaScript on any of those pages can read the stored ciphertext and the plaintext emails, delete or replace the vault and its earlier copies, unregister the isolation service worker, and script open app windows. A user site can also register a service worker for the whole origin, which would then control the app's pages. The data stays encrypted, but for real use, host the app on its **own origin**: a custom domain or subdomain that serves nothing else. That is `jaybi.uz` from 1.3.0 (see [Custom domain jaybi.uz](#custom-domain-jaybiuz)).
- **Until the move, keep no other Pages sites on `kool277`.** Do not create a user site or turn on Pages for any other repository of the account, and check **Settings → Pages** of existing repositories now and then. Also note that giving a user site a custom domain moves project sites without their own domain under it, which would change the old address's origin and hide every vault stored there.
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
/rates/*
  Cache-Control: no-cache
```

Cloudflare Pages uses the same `_headers` format.

**Nginx**: a `location` that sets any `add_header` drops all headers set at the `server` level, so keep the security headers in one file and include it everywhere.

```nginx
# /etc/nginx/snippets/jaybi-headers.conf
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
  server_name jaybi.example.com;
  root /var/www/jaybi;

  include snippets/jaybi-headers.conf;

  location /assets/ {
    include snippets/jaybi-headers.conf;
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  location ~ ^/(index\.html|version\.json|coi-serviceworker\.js|coi-config\.js|rates/.*\.json)$ {
    include snippets/jaybi-headers.conf;
    add_header Cache-Control "no-cache";
  }
}
```

Files in `assets/` have content hashes and can be cached forever. Keep `index.html`, `version.json`, `rates/`, and the two `coi-*` scripts uncached or short-lived, so new releases and rates are picked up.

Outside GitHub, publish rates with a scheduled job on any machine with Node.js 22.12+ and the repository: run `npm run rates:fetch -- --out /srv/moliya-fx` at the times above, then copy `/srv/moliya-fx/rates/` into the site's `rates/` folder only when the command exits with 0. Keep `/srv/moliya-fx` between runs; it holds the previous snapshot used for change detection and the jump check. GitHub Pages caches everything for about 10 minutes, so a release can take that long to reach everyone; the update check fetches `version.json` with `cache: 'no-store'`.

## Monitoring and logging

There is no server-side logging, analytics, or error reporting, by design. Adding any would break the "nothing leaves the device" promise and must be opt-in and documented if ever added. Useful checks:

- The Actions tab and the Security tab (CodeQL, Dependabot) for failures and alerts.
- An uptime check that fetches `version.json`, expects `200`, and compares `version` with the latest tag.
- A freshness check that fetches `rates/latest.json` and alerts when `generatedAt` is more than 4 days old. Failed **Exchange rates** runs also appear in the Actions tab and in GitHub's failure emails.
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
- [ ] `fx-data` protected against deletion and force pushes; only the workflow writes to it.
