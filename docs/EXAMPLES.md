# Real local workflows

## Continue a project without guessing

1. Run `npm run dashboard` and inspect the project graph.
2. Search the selected project for the last architectural decision.
3. Ask the MCP client for the related observations before changing code.
4. Record only the durable outcome after the work is validated.

## Import a Cursor decision safely

1. Export a single chat as Markdown in Cursor.
2. Preview it: `npm run import:sessions -- --source cursor --input ./chat.md`.
3. Confirm that the candidate and redactions look correct.
4. Repeat with `--commit` only when the local bridge is configured.

## Recoverable cleanup

1. Open cleanup candidates in the dashboard.
2. Simulate a candidate first; no database record changes in this step.
3. Read the recoverability notice and confirmation phrase.
4. Delete only the selected candidate after explicit confirmation.

## Share a portable local backup

```bash
export YOURE_ALWAYS_ON_MY_MIND_BACKUP_PASSPHRASE="use-a-long-unique-passphrase"
npm run backup -- --output ./memory.yaomm-backup
npm run backup -- --verify ./memory.yaomm-backup
```

The backup is AES-256-GCM encrypted locally. Keep the passphrase separate from
the backup; the project never sends either over the network.
