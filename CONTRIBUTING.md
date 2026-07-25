# Contributing

Contributions are welcome: adapters, client setup guides, tests, accessibility
improvements and documentation are all useful. Read [ROADMAP.md](ROADMAP.md)
before proposing a new adapter.

1. Create a branch from `main`.
2. Keep changes focused and add tests for behavior changes.
3. Run `npm test` and `npm run doctor` where applicable.
4. Never include memory databases, logs, exported prompts, tokens, credentials
   or real project data in an issue, commit or pull request.
5. Adapter contributions must use explicit files, provide synthetic fixtures,
   redact sensitive values, and document the source format's stability.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a
public issue.
