# Security Policy

## Supported Versions

The `main` branch receives security fixes.

## Reporting a Vulnerability

Please open a private report or contact the repository owner directly. Include:

- Affected command, API route, or platform adapter.
- Steps to reproduce.
- Whether credentials, cookies, or browser profile data may be exposed.

## Sensitive Data

Do not commit:

- `data/browser-profile` or any browser session directory.
- Search exports, screenshots, or scraped user content that is not intended for publication.
- `.env` files, cookies, tokens, or credentials.

The repository `.gitignore` excludes these paths by default.
