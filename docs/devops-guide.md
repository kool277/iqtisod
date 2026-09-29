# DevOps guide

Moliya is a static single-page app. The server only serves files. User data never reaches it, so there is no database to run, no secrets to manage, and nothing to back up on the server side. The operational work is building, deploying, and keeping the website address stable.

## Build

| Item | Value |
| --- | --- |
| Runtime | Node.js 20.19+ or 22.12+ (CI uses 22) |
| Install | `npm ci` (requires the committed `package-lock.json`) |
| Build | `npm run build`, which runs `tsc --noEmit` then `vite build` |
| Output | `dist/` |
| Base path | `./` (relative), so the same build works at a domain root or under a sub-path |
| Routing | Hash-based (`#/app`), so no rewrite or 404 fallback rules are needed |

`dist/` contains `index.html`, `coi-serviceworker.js`, and `assets/` with hashed JavaScript, CSS, and the SQLite WebAssembly binary (about 870 KB, about 410 KB gzipped). The main bundle is about 750 KB (about 240 KB gzipped). Serve `.wasm` as `application/wasm`. GitHub Pages and most hosts do this already.

## Runtime requirements

- **HTTPS is mandatory.** The Web Crypto API only works in a secure context. `http://localhost` is the only non-HTTPS exception.
- **Cross-origin isolation headers are optional.** The current design keeps SQLite in memory on the main thread, which works without them. They are sent anyway so a future worker or OPFS build keeps working:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`

  Vite sets them for `npm run dev` and `npm run preview`. On hosts that cannot set headers, `coi-serviceworker.js` adds them in the browser. That causes one automatic reload on a visitor's first load.
- The app loads nothing from third-party origins.

## Continuous integration and deployment (GitHub Pages)

The workflow is `.github/workflows/deploy.yml`. On every push to `main`, it:

1. Checks out the code and sets up Node 22 with the npm cache.
2. Runs `npm ci`.
3. Runs `npm test` (unit tests).
4. Runs `npx playwright install --with-deps chromium`, then `npm run test:e2e`.
5. Runs `npm run build`.
6. Publishes `dist/` to the `gh-pages` branch with `peaceiris/actions-gh-pages@v4`, using the built-in `GITHUB_TOKEN`.

The job needs `contents: write`. Only one deploy runs at a time (`concurrency: pages`, newer pushes cancel older runs). A failing test stops the deploy, and the last good version stays online.

### First-time setup for this repository

The repository is `kool277/iqtisod`.

1. Commit and push the workflow and the tests. At the time of writing, `.github/` and `tests/` were not committed yet. Without `tests/`, `npm test` fails in CI because Vitest finds no test files.
2. Wait for the **Deploy GitHub Pages** workflow to finish once. It creates the `gh-pages` branch.
3. On GitHub, open **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, branch `gh-pages`, folder `/ (root)`.
4. The site appears at `https://kool277.github.io/iqtisod/` within a few minutes.
5. If the workflow fails with a permissions error, open **Settings → Actions → General → Workflow permissions** and allow **Read and write permissions**.

The repository also tracks an `iqtisod` entry that is a nested git clone rather than project code. It has no `.gitmodules`, so `actions/checkout` skips it. Remove it from the index (`git rm --cached iqtisod`) if it was added by mistake.

### Custom domain

1. Add `cname: finance.example.com` under `with:` in the publish step of the workflow, so every deploy keeps the `CNAME` file.
2. Create a DNS `CNAME` record pointing to `kool277.github.io`.
3. In **Settings → Pages**, enter the domain and enable **Enforce HTTPS**.

Read [Origin and storage isolation](#origin-and-storage-isolation) before switching. Users' vaults do not follow them to a new address.

## Other hosts

Any static host works. Upload `dist/` and, where possible, set the two isolation headers.

**Netlify**: add `public/_headers` (Vite copies it into `dist/`):

```text
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
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

  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    add_header Cross-Origin-Opener-Policy same-origin always;
    add_header Cross-Origin-Embedder-Policy require-corp always;
  }

  location = /index.html {
    add_header Cache-Control "no-cache";
    add_header Cross-Origin-Opener-Policy same-origin always;
    add_header Cross-Origin-Embedder-Policy require-corp always;
  }
}
```

Files in `assets/` have content hashes and can be cached forever. Keep `index.html` and `coi-serviceworker.js` uncached or short-lived, so new releases are picked up. GitHub Pages caches everything for about 10 minutes, so a release can take that long to reach everyone.

## Origin and storage isolation

This is the most important operational topic, because it decides whether users can reach their data.

- **A vault belongs to an origin** (scheme, host, and port). IndexedDB is per origin. Moving from `kool277.github.io` to a custom domain, or changing a port, gives users an empty app. Their vault still exists at the old address. Announce a move ahead of time, and ask admins to export a backup at the old address and import it at the new one. Keep the old address online during the transition.
- **Paths do not isolate.** `https://kool277.github.io/iqtisod/` shares its origin with every other project page under `kool277.github.io`. JavaScript on any of those pages can read the stored ciphertext and the plaintext emails, and can delete or replace the vault. The data stays encrypted, but for real use, host Moliya on its **own origin**: a custom domain or subdomain that serves nothing else.
- **Redeploying never touches user data.** Data lives only in users' browsers. Rolling back the code does not roll back or delete anyone's vault.
- **Compatibility matters on every release.** A new build must still open vaults and backups made by older builds. There is no schema migration system yet (see the [developer guide](developer-guide.md#change-the-schema)), so treat schema changes as breaking until one exists.

## Releases and rollback

- **Release**: merge to `main`. CI tests, builds, and publishes.
- **Rollback**: `git revert` the bad commit and push, which runs the normal pipeline. For an emergency, re-run the workflow of the last good commit from the **Actions** tab, or reset the `gh-pages` branch to its previous commit.
- **Versioning**: bump `version` in `package.json` and tag releases (`git tag v1.1.0`), so it is clear which build produced which backups.

## Monitoring and logging

There is no server-side logging, analytics, or error reporting, by design. Adding any would break the "nothing leaves the device" promise and must be opt-in and documented if ever added. Useful checks:

- The Actions tab for failed deploys.
- An uptime check that fetches `index.html` and one asset, and expects `200`.
- After each deploy, open the site, create a throwaway vault in a private window, and add one record.

## Dependency maintenance

- Run `npm outdated` and `npm audit` monthly. Upgrade in a branch and let CI run the full test suite.
- `@sqlite.org/sqlite-wasm` is pinned to an exact version (`3.53.4-build1`). Upgrade deliberately, and verify that `sqlite3_deserialize` and `sqlite3_js_db_export` still behave the same with an existing backup.
- `public/coi-serviceworker.js` is a vendored copy of coi-serviceworker v0.1.7 (MIT). Update it by downloading the new file from the upstream repository.
- Playwright browsers must match the Playwright version. CI installs them on every run.

## Security checklist

- [ ] Served only over HTTPS. Enforce HTTPS in Pages settings.
- [ ] Hosted on a dedicated origin for production use.
- [ ] Branch protection on `main`: require the workflow to pass, and require reviews for changes to `src/crypto`, `src/services/auth.service.ts`, and the workflow file.
- [ ] Actions permissions limited to what the workflow needs (`contents: write`).
- [ ] No analytics or third-party scripts added to `index.html`.
- [ ] Consider a Content Security Policy once inline scripts are moved out of `index.html`.
