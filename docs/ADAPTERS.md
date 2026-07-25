# Adapters and client integrations

You're Always on My Mind is a local MCP server. It deliberately separates the
interface used by AI clients from the storage that holds your memories.

## Client connection

Any client that supports an MCP server over standard input/output can use this
command after installation:

```json
{
  "mcpServers": {
    "youre-always-on-my-mind": {
      "command": "node",
      "args": ["/absolute/path/to/youre_always_on_my_mind/src/index.js"]
    }
  }
}
```

Claude Code and Codex are supported through this standard MCP shape. For
Cursor, Lovable, Replit, Antigravity, or any other tool, use its current MCP
settings if it offers a stdio connection. A client integration is not a claim
that the client captures memories automatically; it is the connection that lets
the client search and record the memories you choose.

## Copyable MCP configurations

Ready-to-copy local configurations live in [examples/mcp](../examples/mcp):

- `claude-code.json` for Claude Code project configuration.
- `codex.toml` for Codex.
- `cursor.mcp.json` for Cursor's `.cursor/mcp.json`.
- `generic-stdio.json` for another compatible stdio client.
- `replit.md` explains the local-only boundary for Replit.

Replace `/absolute/path/to/...` with the local checkout path. Never add a
database path, backup passphrase, token, or personal directory to a shared
configuration.

`npm run setup` writes the compatible `.mcp.json` entry interactively. It
checks that a local memory bridge exists and preserves unrelated server entries.

## Encrypted local backup

`npm run backup` packages the configured database and feedback log using
AES-256-GCM with an scrypt-derived key. It requires a passphrase from an
environment variable, not from a command argument:

```bash
export YOURE_ALWAYS_ON_MY_MIND_BACKUP_PASSPHRASE="use-a-long-unique-passphrase"
npm run backup -- --output ./memory.yaomm-backup
npm run backup -- --verify ./memory.yaomm-backup
```

Use `--dry-run` to inspect selected file names and sizes. Keep the passphrase
separate from the encrypted file. Restore is intentionally not implemented yet:
the roadmap requires a compatibility and recoverability review first.

## Storage adapters

Set `YOURE_ALWAYS_ON_MY_MIND_BRIDGE_PATH` to a local executable that accepts a
command and prints exactly one JSON value to standard output. The gateway never
passes data to a hosted service.

The current dashboard needs these read commands:

```text
health | stats | recent <limit> | projects <limit> | semantic <limit>
embedding-health | alerts | timeline <range> <bucket>
project-memories ... | inspect-memory ... | cleanup-candidates ...
```

The MCP server additionally uses `search`, `semantic-search`, `record`,
`alert-config-get`, `alert-config-set`, `alert-config-reset`, and the three
`cleanup-*` commands. See the tool calls in `src/index.js` for the exact
arguments and response fields. Implement only the capabilities you want to
expose; return a non-zero exit status for unsupported operations.

## Personal data, repositories and projects

Your adapter decides where data lives: a SQLite file, a folder of Markdown
notes, exported coding-agent history, or your own repository metadata. Use the
`project` field to partition memories however you prefer: repository name,
client, product, or team.

Never place a database, export, token, `.env` file, tunnel URL, or personal
machine path in a public fork. Keep those values in local configuration.

## Ready local importers

The importer reads only files you explicitly provide. It is dry-run by default,
extracts the latest assistant outcome per session, redacts common secrets,
emails and phone numbers, and does not make network requests.

```bash
# Preview one Claude Code session.
npm run import:sessions -- --source claude-code --input ~/.claude/projects/<project>/<session>.jsonl

# Preview one Codex session.
npm run import:sessions -- --source codex --input ~/.codex/sessions/<date>/<session>.jsonl

# Commit reviewed candidates to your configured local bridge.
npm run import:sessions -- --source codex --input ~/.codex/sessions/<date>/<session>.jsonl --commit
```

### Cursor

Cursor stores chat history locally and supports exporting a chat as Markdown.
Export the chat in Cursor, then preview the exported `.md` file explicitly:

```bash
npm run import:sessions -- --source cursor --input ./cursor-chat.md
```

The parser reads the last `Assistant`, `Cursor`, or `Agent` section. It never
discovers or opens Cursor's SQLite history database automatically.

### Replit

Replit preserves Agent context in checkpoints, but does not document a stable
local transcript path. Export the conversation or checkpoint metadata as JSON
or JSONL, then provide it explicitly:

```bash
npm run import:sessions -- --source replit --input ./replit-agent-export.json
```

The parser reads the final assistant message, or falls back to the latest
checkpoint description. It makes no network requests and never uses Replit
credentials.

### Lovable and Antigravity

Lovable and Antigravity remain on the generic JSONL/MCP path until they publish
stable, supported transcript formats. Export a JSONL file with `project`,
`title`, `summary` and optional `agent` (`codex`, `claude-code`, or `other`)
fields and use `--source generic`.
