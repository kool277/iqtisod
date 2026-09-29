# DevOps guide

Moliya is a static single-page app. The server only serves files. User data never reaches it, so there is no database to run, no secrets to manage, and nothing to back up on the server side. The operational work is building, releasing, deploying, keeping the website address stable, and making sure every release still opens every vault and backup ever made.

## Build

| Item | Value |
| --- | --- |
| Runtime | Node.js 22.12+ (`.nvmrc`; CI uses the same file) |
| Install | `npm ci` (requires the committed `package-lock.json`) |
| Build | `npm run build`, which runs `tsc --noEmit` then `vite build` |
| Output | `dist/` |
| Base path | `./` (relative), so the same build works at a domain root or under a sub-path |
| Routing | Hash-based (`#/app`), so no rewrite or 404 fallback rules are needed |

`dist/` contains:

- `index.html` with the Content Security Policy `<meta>` tag (added only in production builds).
- `version.json` with `version`, `commit`, and `builtAt`. Running apps poll it to detect a new deployment.
- `coi-config.js` and `coi-serviceworker.js`.
- `assets/` with hashed files. The first screen loads only the app entry (about 115 KB in two files, 38 KB gzipped) and React (about 260 KB, 80 KB gzipped). Pages, Chart.js (about 180 KB), and SQLite (about 210 KB of JavaScript plus an 870 KB WebAssembly binary, about 400 KB gzipped) load on demand. Serve `.wasm` as `application/wasm`; GitHub Pages and most hosts do this already.

`dist/` does not contain exchange rates. The deploy adds `rates/` from the `fx-data` branch (see [Exchange rates](#exchange-rates)); a release zip opened on its own shows the rates panel as unavailable unless `rates/` is copied next to `index.html`.

Builds are reproducible: the build date comes from `SOURCE_DATE_EPOCH` or the commit date, not the clock, and the commit comes from `git` (or `GITHUB_SHA`).

## Runtime requirements

- **HTTPS is mandatory.** The Web Crypto API only works in a secure context. `http://localhost` is the only non-HTTPS exception.
- **Cross-origin isolation headers are optional.** The current design keeps SQLite in memory on the main thread, which works without them. They are sent anyway so a future worker or OPFS build keeps working:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`

  Vite sets them for `npm run dev` and `npm run preview`. On hosts that cannot set headers, `coi-serviceworker.js` adds them in the browser. That causes one automatic reload on a visitor's first load.
- **Web Locks and IndexedDB** are required. Every supported browser has both.
- The app loads nothing from third-party origins. Exchange rates are read from `rates/latest.json` on the same site.

## Content Security Policy

The production `index.html` carries:

```text
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:;
manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'
```

- `'wasm-unsafe-eval'` is needed to compile SQLite. `'unsafe-inline'` for styles is needed by Chart.js and React style attributes; scripts have no inline exception.
- `data:` images are stored receipts.
- `connect-src 'self'` covers `version.json` and `rates/latest.json`. Do not add the central banks' domains: the browser never calls them.
- A `<meta>` policy cannot set `frame-ancestors`, `report-uri`, or `sandbox`. If the host can send headers, send the same policy as a `Content-Security-Policy` header and add `frame-ancestors 'none'`.
- The development server has no policy, so Vite's hot reload works. `npm run test:e2e:preview` (and CI) run the browser tests against the production build and fail on any policy violation.

## Continuous integration and deployment (GitHub Pages)

All actions are pinned to full commit SHAs with the release tag in a comment. Dependabot keeps them current.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | Pull requests, pushes to branches other than `main`, called by the other workflows | Typecheck, unit tests, `npm audit --omit=dev --audit-level=high`, build (uploads `dist` as an artifact), Playwright against the production preview, dependency review on pull requests |
| `deploy.yml` | Push to `main`, manual | Runs `ci.yml`, then publishes the tested `dist` artifact to `gh-pages` in the `production` environment |
| `release.yml` | Tag `vX.Y.Z` | Runs `ci.yml`, checks the tag equals `package.json`'s version, packages `moliya-X.Y.Z.zip` and `SHA256SUMS`, attests build provenance, and creates a GitHub release with the notes from `CHANGELOG.md` |
| `codeql.yml` | Push and pull request to `main`, weekly | CodeQL `security-extended` for JavaScript and TypeScript |
| `fx-rates.yml` | 03:17 UTC daily and 15:47 UTC on weekdays, manual | Fetches, validates, and records official exchange rates on `fx-data`, then publishes `rates/` to `gh-pages`. See [Exchange rates](#exchange-rates) |

The deploy only publishes the exact files CI tested. A failing check stops it, and the last good version stays online. Deploys and rate updates never overlap or cancel each other half-way (`concurrency: pages`, `cancel-in-progress: false`).

### One-time GitHub settings

The repository is `kool277/iqtisod`. These settings cannot be committed and must be set by an owner:

1. **Settings → Pages → Build and deployment**: **Deploy from a branch**, branch `gh-pages`, folder `/ (root)`. Enable **Enforce HTTPS**. (If you ever switch to "GitHub Actions" as the source, change `deploy.yml` to `actions/deploy-pages` at the same time, or the site stops updating.)
2. **Settings → Environments → New environment** `production`. Optionally add required reviewers and restrict deployment branches to `main`, so a person approves each production deploy.
3. **Settings → Actions → General → Workflow permissions**: keep **Read repository contents** as the default. Each job asks for the write permissions it needs.
4. **Settings → Rules → Rulesets** (or Branches) for `main`: require a pull request, require the status checks **Typecheck, unit tests, audit, build**, **End-to-end tests (production preview)**, and **Analyze (javascript-typescript)**, block force pushes and deletion.
5. A tag ruleset for `v*`: restrict creation to maintainers and block deletion and updates, so a released tag always points at the same code.
6. **Settings → Code security**: enable Dependabot alerts, Dependabot security updates, secret scanning with push protection, and code scanning (the CodeQL workflow uploads results once enabled).
7. **Exchange rates**: after the workflow reaches `main`, run **Actions → Exchange rates → Run workflow** once to create the `fx-data` branch, then re-run **Deploy GitHub Pages** (or push to `main`) so the site and the rates are published together. If rulesets cover all branches, let `github-actions[bot]` push to `fx-data` and `gh-pages` (or exclude those two branches); do not require pull requests or status checks on them. Block deletion and force pushes on `fx-data`: it is the audit trail of every published rate.

The repository also tracks an `iqtisod` entry that is a nested git clone rather than project code. It has no `.gitmodules`, so `actions/checkout` skips it, and CodeQL ignores it. Remove it from the index (`git rm --cached iqtisod`) if it was added by mistake.

### Custom domain

1. Add `cname: finance.example.com` under `with:` in the publish step of `deploy.yml`, so every deploy keeps the `CNAME` file.
2. Create a DNS `CNAME` record pointing to `kool277.github.io`.
3. In **Settings → Pages**, enter the domain and enable **Enforce HTTPS**.

Read [Origin and storage isolation](#origin-and-storage-isolation) before switching. Users' vaults do not follow them to a new address.

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
4. Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e:preview`.
5. Merge to `main` through a pull request. `deploy.yml` publishes the site.
6. Tag the merge commit and push the tag:

   ```bash
   git tag -a vX.Y.Z -m "Moliya X.Y.Z"
   git push origin vX.Y.Z
   ```

   `release.yml` builds the release assets. Keep the zip: it is the exact build that can open the data of that version offline.

Running apps notice the new `version.json` within 30 minutes, or when the tab becomes visible again, and show "A new version of Moliya is available". Reload locks the vault first, so unsaved work is saved.

### Rollback

- Code: `git revert` the bad commit on `main` and push; the normal pipeline redeploys. In an emergency, re-run **Deploy GitHub Pages** for the last good commit from the Actions tab, or reset `gh-pages` to its previous commit.
- **Data after a format change.** If a release upgraded users' vaults (for example 1.0.0 → 1.1.0), rolling the code back does not roll the data back. An older build refuses a newer record with the message "This vault was saved by a newer version of Moliya" instead of damaging it. Users are not stuck:
  - each upgraded browser keeps the original record as an archive (Backup page → Earlier copies in this browser), which the older build can import;
  - backups taken before the upgrade still open in the older build;
  - `npm run decrypt` opens any version.

  Prefer rolling forward with a fix.

## Origin and storage isolation

This is the most important operational topic, because it decides whether users can reach their data.

- **A vault belongs to an origin** (scheme, host, and port). IndexedDB is per origin. Moving from `kool277.github.io` to a custom domain, or changing a port, gives users an empty app. Their vault still exists at the old address. Announce a move ahead of time, and ask admins to export a backup at the old address and import it at the new one. Keep the old address online during the transition.
- **Paths do not isolate.** `https://kool277.github.io/iqtisod/` shares its origin with every other project page under `kool277.github.io`. JavaScript on any of those pages can read the stored ciphertext and the plaintext emails, and can delete or replace the vault. The data stays encrypted, but for real use, host Moliya on its **own origin**: a custom domain or subdomain that serves nothing else.
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

Any static host works. Upload `dist/` and, where possible, set the isolation headers and the policy as headers.

**Netlify**: add `public/_headers` (Vite copies it into `dist/`):

```text
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Content-Security-Policy: frame-ancestors 'none'
/version.json
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/rates/*
  Cache-Control: no-cache
```

Cloudflare Pages uses the same `_headers` format.

**Nginx**:

```nginx
server {
  listen 443 ssl;
  server_name finance.example.com;
  root /var/www/moliya;

  add_header Cross-Origin-Opener-Policy same-origin always;
  add_header Cross-Origin-Embedder-Policy require-corp always;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;
  add_header Content-Security-Policy "frame-ancestors 'none'" always;

  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    add_header Cross-Origin-Opener-Policy same-origin always;
    add_header Cross-Origin-Embedder-Policy require-corp always;
  }

  location ~ ^/(index\.html|version\.json|coi-serviceworker\.js|coi-config\.js|rates/.*\.json)$ {
    add_header Cache-Control "no-cache";
    add_header Cross-Origin-Opener-Policy same-origin always;
    add_header Cross-Origin-Embedder-Policy require-corp always;
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

- Dependabot opens grouped pull requests weekly for npm and GitHub Actions. CI must pass before merging.
- `@sqlite.org/sqlite-wasm` is pinned to an exact version (`3.53.4-build1`). Upgrade deliberately; the fixture tests verify that every stored database still opens and migrates.
- `public/coi-serviceworker.js` is a vendored copy of coi-serviceworker v0.1.7 (MIT). Update it by downloading the new file from the upstream repository.
- Playwright browsers must match the Playwright version. CI installs them on every run.

## Security checklist

- [ ] Served only over HTTPS. Enforce HTTPS in Pages settings.
- [ ] Hosted on a dedicated origin for production use.
- [ ] Branch and tag rulesets as described in [One-time GitHub settings](#one-time-github-settings), with reviews required for changes to `src/crypto`, `src/db`, `src/services/auth.service.ts`, and `.github/`.
- [ ] `production` environment in place; workflow default permissions read-only.
- [ ] Code scanning, Dependabot alerts, and secret scanning enabled.
- [ ] No analytics or third-party scripts added to `index.html`; the policy blocks them anyway.
- [ ] Release zips and `SHA256SUMS` kept for every version.
- [ ] `fx-data` protected against deletion and force pushes; only the workflow writes to it.
