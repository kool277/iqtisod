# Security policy

Jaybi (called Moliya before 1.3.0) is a private finance vault that runs entirely in the browser. It is served at [jaybi.uz](https://jaybi.uz). There is no server and no account system: the data is an encrypted SQLite database stored in the browser, and the website only serves static files. This file explains which versions get fixes, how to report a problem, and what is in scope.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.4.x | Yes (1.4.2 and later; 1.4.2 fixes the findings of the September 2026 review) |
| 1.3.x and older | No. Upgrade to the latest 1.4 release |

Fixes are released as a new patch version and deployed to the website. Every release opens vaults and backups made by every earlier version, so upgrading never requires moving data by hand.

## Reporting a vulnerability

Report privately through GitHub: [open a security advisory](https://github.com/kool277/iqtisod/security/advisories/new). Do not open a public issue, pull request, or discussion for a security problem.

Please include:

- the Jaybi version (shown at the bottom of the menu, on the sign-in screen, and in Settings → About) and the browser and operating system;
- what an attacker needs (for example: a copy of a backup, another page on the same origin, a crafted backup file, access to an unlocked device);
- steps to reproduce, and a proof of concept if you have one;
- what you think the impact is;
- whether you want to be credited, and under which name.

Never include real vault data, backups, or passwords. Make a throwaway vault to reproduce the problem.

## What to expect

- **Acknowledgement** within 3 business days.
- **Assessment** within 10 business days: whether we can reproduce it, how severe it is, and what happens next.
- **Fix**: the timeline depends on severity. Problems that expose vault contents or keys come first. We keep you informed and agree on a disclosure date with you. Fixed issues are published as GitHub security advisories and noted in the [changelog](CHANGELOG.md).

## Scope

In scope:

- The app code in this repository (`src/`, `public/`, `index.html`, the build configuration), as deployed.
- The recovery tool `tools/moliya-decrypt.mjs` (`npm run decrypt`).
- The stored formats described in [docs/data-format.md](docs/data-format.md): the encrypted record, backup files, and how they are read.

Out of scope:

- Denial of service against the website or the host.
- The GitHub infrastructure and the GitHub Pages platform itself. Report those to GitHub.
- Social engineering, including phishing of vault members.
- Attacks that need a compromised device, operating system, or browser, or a malicious browser extension.
- Weak passwords chosen by users. The app enforces a minimum policy; it cannot stop someone guessing offline against a copy protected by a weak password.
- Findings that only restate the known limits below.

## Safe harbor

We will not take legal action against, or ask others to take action against, anyone who researches in good faith: who makes a reasonable effort to avoid privacy violations and data loss, only uses vaults they created, does not degrade the service for others, reports through the channel above, and gives us reasonable time to fix the problem before disclosing it. If in doubt, ask first through the same channel.

## Threat model in brief

The full model is in the [developer guide](docs/developer-guide.md#threat-model).

- **Protected**: data at rest. The database is encrypted with AES-256-GCM under a random vault key. Each person's password is stretched with PBKDF2-SHA-256 (600,000 iterations) into a key that wraps a copy of the vault key. Private safes are encrypted a second time with keys only their owner can derive.
- **Offline guessing**: anyone with a copied backup or browser storage can guess passwords without limit. Only a strong password protects them. The in-app attempt limits and the optional sign-in check (an authenticator code) apply only inside the app; they add no encryption.
- **One-time codes**: invite and reset codes carry 135 random bits and are valid for 24 hours unless the Admin picks 15 minutes to 7 days. Their expiry and single use are enforced by the app, so a backup made while a code was open, plus that code, opens that backup.
- **Exports**: only Admins can export. Encrypted exports need a password of at least 14 printable ASCII characters that is not the sign-in password, not a common password, and not built from the vault name or a member's email; an encrypted ZIP also needs a strong one, because the ZIP format is quick to guess against, and the app suggests a generated password. Unencrypted exports need an explicit confirmation. CSV text cells are always quoted and formula-like text is neutralised. Every export is audited, and no export contains private safes or key material.
- **Same origin**: every page on the same origin can read and delete the stored vault. Since 1.3.0 the app is served from its own origin, `jaybi.uz`, which serves nothing else; the old `kool277.github.io/iqtisod` address redirects there. See the [DevOps guide](docs/devops-guide.md#origin-and-storage-isolation).
- **Hostile backups**: imported files are size-capped, parsed defensively, and opened in a hardened SQLite whose every table, index, trigger, and view must match the app's own schema. A password copy is bound to its person: a relabelled or duplicated one is refused.
- **Scripts in the page**: a strict Content Security Policy with Trusted Types, no third-party scripts, and a frame guard. Script running in the page could still read an unlocked vault.
- **Audit log**: hash-chained and checked against the last head each browser saw, so damage, truncation, and rewriting are reported to Admins on a browser that saw the log before. It is not signed: a member who knows a password can rewrite it with other tools.
- **Locking**: locking reloads the page, so no decrypted data or keys stay in the page's memory afterwards.
- **Known limits** (not addressed in 1.4.2): roles are enforced by the app, not by encryption; the vault key does not rotate when a person is removed or a password is reset (that needs a key pair per person); audit entries are not signed per person; passwords are stretched with PBKDF2, not a memory-hard function such as Argon2id; private safe items can be rolled back to an older copy by someone with the vault key (a new item format with a revision in its additional data is planned); the unencrypted envelope fields (dates, versions) are not covered by one authentication tag; email addresses are stored unencrypted; GitHub Pages cannot send HSTS or other security headers, which would need a proxy such as Cloudflare in front. See the [admin guide](docs/admin-guide.md#security-limits-to-know).
