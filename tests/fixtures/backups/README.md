# Golden backup fixtures

Every file here is a real `.moliya` backup written by a released build of Moliya, with its known passwords and expected contents in the matching `.expected.json`. `tests/unit/fixtures.test.ts` imports every fixture listed in `MANIFEST.json` with the current code, runs all migrations, unlocks it as every user, and checks the exact records and totals.

Rules:

1. **Never edit or delete a fixture.** `SHA256SUMS` in each folder pins the bytes, and the test fails if a listed file changes or disappears.
2. **Every data-format change adds a fixture.** When the backup format, the vault record format, or the SQLite schema version changes, generate a fixture with the new release and add it to `MANIFEST.json`. The test fails if any format version from 1 to the current one has no fixture.
3. Fixtures are produced by the release's own code, not by hand. The generators live in `tools/fixtures/<version>/` and run with `npm run fixtures:generate -- tools/fixtures/<version>`. A generator refuses to overwrite an existing file.

See [docs/data-format.md](../../../docs/data-format.md) for the formats themselves.
