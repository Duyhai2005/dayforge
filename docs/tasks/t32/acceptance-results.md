# T32 staging acceptance results

**Status: TARGET_PENDING.** No staging origin, isolated host/database, SMTP inbox, immutable release manifest, or second device has been registered for this run. The records below do not claim that a staging or production acceptance test passed.

The detailed evidence ledger is [acceptance-results.json](acceptance-results.json). All 38 criteria remain `TARGET_PENDING`; this preserves the historical T28 results and keeps T32 incomplete until the same candidate is tested end to end. AC-31, AC-32, and AC-36 are marked for a later production recheck.

When a candidate is deployed, record one immutable run manifest under `docs/tasks/t32/evidence/<run-id>/run.json` with `artifact_type: dayforge-staging-evidence`, the candidate release ID, git SHA, build ID, web/API digests, scope, and UTC test time. Each PASS row must point to that manifest and its specific evidence. Do not include passwords, session cookies, email tokens, raw private notes, or decrypted local data.

Validate a completed ledger against the same release manifest with:

```powershell
uv run --directory backend --locked python ../scripts/validate_acceptance.py --results ../docs/tasks/t32/acceptance-results.json --release <private-release.json>
```

The command exits nonzero while a row is pending, failed, blocked, lacks run evidence, or refers to a different release. Passing automation alone does not satisfy inbox, second-device, owner-switch, or PC-off observations.
