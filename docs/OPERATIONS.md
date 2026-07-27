# Operations Guide

## Browser Profiles

The tool can reuse a Chrome profile to keep platform login state available across runs.

```bash
SYNC_CHROME_PROFILE=1 CHROME_PROFILE_NAME="Profile 1" npm run search:web
```

Runtime browser state is stored under `data/` and must not be committed.

## Automated Comment Flow

The main web UI can automatically execute comments after search results are collected.

- TikTok videos: opens the comment panel, skips when an existing matching comment is detected, can reply to a top-liked comment, sends the main comment, and verifies the result.
- Facebook Reels: opens each reel, sends/replies with the selected comment text, and records whether the send was verified.
- Facebook posts: opens eligible posts from search results and sends the main comment.

The status API and UI report outcomes such as `main_comment_sent`, `top_liked_comment_reply_sent`, `existing_comment_found`, `comment_input_not_found_or_not_fillable`, and `comment_send_not_ready`.

## Common States

- `login_required`: sign in manually in the opened browser window.
- `captcha`: complete the platform challenge manually.
- `geo_blocked`: the current network exit is blocked by the platform.
- `no_results`: the platform loaded but no matching content was extracted.
- `existing_comment_found`: a matching existing comment was detected, so the item is skipped.
- `comment_send_not_ready`: the comment flow started but the send action was not ready or could not be verified.

## Output Files

Search runs can create JSON, CSV, and screenshot files under `data/searches/`.
Treat these outputs as local artifacts. Review them before sharing because they may contain third-party content.
