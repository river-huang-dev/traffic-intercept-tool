# Operations Guide

## Browser Profiles

The tool can reuse a Chrome profile to keep platform login state available across runs.

```bash
SYNC_CHROME_PROFILE=1 CHROME_PROFILE_NAME="Profile 1" npm run search:web
```

Runtime browser state is stored under `data/` and must not be committed.

## Common States

- `login_required`: sign in manually in the opened browser window.
- `captcha`: complete the platform challenge manually.
- `geo_blocked`: the current network exit is blocked by the platform.
- `no_results`: the platform loaded but no matching content was extracted.

## Output Files

Search runs can create JSON, CSV, and screenshot files under `data/searches/`.
Treat these outputs as local artifacts. Review them before sharing because they may contain third-party content.
