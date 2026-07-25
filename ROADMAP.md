# Public roadmap

## Now

- [x] Local graph, semantic search, quality signals and safe cleanup.
- [x] Claude Code, Codex, Cursor and Replit import paths.
- [x] One-command local MCP onboarding and encrypted local backup/export.
- [x] Copyable MCP client configurations and real workflow examples.

## Next

- [ ] Validate native client formats with real exported fixtures contributed by
  users, with all personal data removed.
- [ ] Improve the onboarding assistant from user feedback and doctor failures.
- [ ] Add backup restore only after a recoverability and compatibility review.
- [ ] Publish community-maintained adapter conformance tests.

## Community adapters

Adapter contributions are welcome. Each adapter must be local by default, read
only explicit files, redact sensitive values, include synthetic fixtures, and
document its format's stability and source. Open an issue before adding a
format that is not publicly documented.

## Optional paid features

No paid feature is planned before the local open-source workflow is proven.
Any future optional offer must be opt-in, must not gate local memory, exports,
or adapters, and must not introduce silent telemetry or external model calls.
