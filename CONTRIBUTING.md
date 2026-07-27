# Contributing

Thanks for taking the time to improve Traffic Intercept Tool.

## Development Setup

```bash
npm install
npm run check
```

Run the local web UI:

```bash
npm run search:web
```

## Pull Request Checklist

- Keep platform-specific scraping logic inside `src/channels/` or clearly named helpers.
- Do not commit browser profiles, screenshots, exported search data, logs, cookies, or credentials.
- Update `README.md` and files under `docs/` when behavior, commands, or outputs change.
- Run `npm test` before opening a pull request.

## Responsible Use

This project automates browser-based discovery workflows. Contributors should avoid changes that bypass access controls, hide automation from a platform, or encourage spam, credential collection, or abusive behavior.
