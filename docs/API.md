# HTTP API

The local server listens on `127.0.0.1:4318` by default.

## `GET /api/chrome-profiles`

Lists local Chrome profiles that can be selected from the web UI.

## `POST /api/search`

Runs a platform search.

```json
{
  "channel": "tiktok",
  "keyword": "pinjaman online indonesia",
  "limit": 10,
  "headed": true,
  "chromeProfileName": "Profile 1"
}
```

Supported channels:

- `tiktok`
- `facebook`

For Facebook, pass `facebookContentType` as `post` or `reels`.

## `POST /api/review-sequence`

Starts an automated browser review/comment sequence for selected result URLs.

```json
{
  "channel": "facebook",
  "hrefs": ["https://www.facebook.com/..."],
  "holdMs": 30000,
  "randomHoldMs": 30000,
  "chromeProfileName": "Profile 1"
}
```

## `GET /api/review-sequence`

Returns the active review/comment sequence state, including progress, completed items, skipped items, failures, detected existing comments, and per-result send verification.

## `POST /api/review-sequence/stop`

Stops the active review/comment sequence.

## `POST /api/debug/video-navigation`

Diagnoses whether the browser can open and inspect a given video URL.
