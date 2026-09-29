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
- `assets/` with hashed files. The first screen loads only the app entry (about 110 KB, 35 KB gzipped) and React (about 260 KB, 80 KB gzipped). Pages, Chart.js (about 180 KB), and SQLite (about 210 KB of JavaScript plus an 870 KB WebAssembly binary, about 400 KB gzipped) load on demand. Serve `.wasm` as `application/wasm`; GitHub Pages and most hosts do this already.

Builds are reproducible: the build date comes from `SOURCE_DATE_EPOCH` or the commit date, not the clock, and the commit comes from `git` (or `GITHUB_SHA`).

## Runtime requirements

- **HTTPS is mandatory.** The Web Crypto API only works in a secure context. `http://localhost` is the only non-HTTPS exception.
- **Cross-origin isolation headers are optional.** The current design keeps SQLite in memory on the main thread, which works without them. They are sent anyway so a future worker or OPFS build keeps working:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`

  Vite sets them for `npm run dev` and `npm run preview`. On hosts that cannot set headers, `coi-serviceworker.js` adds them in the browser. That causes one automatic reload on a visitor's first load.
- **Web Locks and IndexedDB** are required. Every supported browser has both.
- The app loads nothing from third-party origins.

## Content Security Policy

The production `index.html` carries:

```text
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:;
manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'
```

- `'wasm-unsafe-eval'` is needed to compile SQLite. `'unsafe-inline'` for styles is needed by Chart.js and React style attributes; scripts have no inline exception.
- `data:` images are stored receipts.
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

The deploy only publishes the exact files CI tested. A failing check stops it, and the last good version stays online. Deploys never cancel each other half-way (`concurrency: pages`, `cancel-in-progress: false`).

### One-time GitHub settings

The repository is `kool277/iqtisod`. These settings cannot be committed and must be set by an owner:

1. **Settings → Pages → Build and deployment**: **Deploy from a branch**, branch `gh-pages`, folder `/ (root)`. Enable **Enforce HTTPS**. (If you ever switch to "GitHub Actions" as the source, change `deploy.yml` to `actions/deploy-pages` at the same time, or the site stops updating.)
2. **Settings → Environments → New environment** `production`. Optionally add required reviewers and restrict deployment branches to `main`, so a person approves each production deploy.
3. **Settings → Actions → General → Workflow permissions**: keep **Read repository contents** as the default. Each job asks for the write permissions it needs.
4. **Settings → Rules → Rulesets** (or Branches) for `main`: require a pull request, require the status checks **Typecheck, unit tests, audit, build**, **End-to-end tests (production preview)**, and **Analyze (javascript-typescript)**, block force pushes and deletion.
5. A tag ruleset for `v*`: restrict creation to maintainers and block deletion and updates, so a released tag always points at the same code.
6. **Settings → Code security**: enable Dependabot alerts, Dependabot security updates, secret scanning with push protection, and code scanning (the CodeQL workflow uploads results once enabled).

A local `iqtisod/` directory, if present, is a nested git clone rather than project code. `.gitignore` excludes it; do not add it back to the index, because a gitlink without `.gitmodules` breaks `actions/checkout`.

### Custom domain

1. Add `cname: finance.example.com` under `with:` in the publish step of `deploy.yml`, so every deploy keeps the `CNAME` file.
2. Create a DNS `CNAME` record pointing to `kool277.github.io`.
3. In **Settings → Pages**, enter the domain and enable **Enforce HTTPS**.

Read [Origin and storage isolation](#origin-and-storage-isolation) before switching. Users' vaults do not follow them to a new address.

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
- **Data after a format change.** If a release upgraded users' vaults (for example 1.0.0 → 1.1.0, or 1.1.0 → 1.2.0 with schema 3), rolling the code back does not roll the data back. An older build refuses a newer record with the message "This vault was saved by a newer version of Moliya" instead of damaging it. Users are not stuck:
  - each upgraded browser keeps the original record as an archive (Backup page → Earlier copies in this browser), which the older build can import (anything done in the newer release, such as private safes created in 1.2.0, is not in it);
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

  location ~ ^/(index\.html|version\.json|coi-serviceworker\.js|coi-config\.js)$ {
    add_header Cache-Control "no-cache";
    add_header Cross-Origin-Opener-Policy same-origin always;
    add_header Cross-Origin-Embedder-Policy require-corp always;
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

- Dependabot opens grouped pull requests weekly for npm and GitHub Actions. CI must pass before merging.
- `@sqlite.org/sqlite-wasm` is pinned to an exact version (`3.53.4-build1`). Upgrade deliberately; the fixture tests verify that every stored database still opens and migrates.
- `public/coi-serviceworker.js` is a vendored copy of coi-serviceworker v0.1.7 (MIT). Update it by downloading the new file from the upstream repository.
- Playwright browsers must match the Playwright version. CI installs them on every run.

## Security checklist

- [ ] Served only over HTTPS. Enforce HTTPS in Pages settings.
- [ ] Hosted on a dedicated origin for production use.
- [ ] Branch and tag rulesets as described in [One-time GitHub settings](#one-time-github-settings), with reviews required for changes to `src/crypto`, `src/db`, `src/services/auth.service.ts`, `src/services/account.service.ts`, `src/services/safe.service.ts`, `tools/moliya-decrypt.mjs`, and `.github/`.
- [ ] `production` environment in place; workflow default permissions read-only.
- [ ] Code scanning, Dependabot alerts, and secret scanning enabled.
- [ ] No analytics or third-party scripts added to `index.html`; the policy blocks them anyway.
- [ ] Release zips and `SHA256SUMS` kept for every version.
