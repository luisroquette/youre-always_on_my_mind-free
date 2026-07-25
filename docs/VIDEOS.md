# Short-video production scripts

These scripts are designed for local screen capture. They do not require an AI
video API or send project data outside the machine.

## 1. Find the decision (20 seconds)

1. Open the dashboard graph and select one project (0-5s).
2. Search for an architectural decision (5-12s).
3. Open the connected observation and show its source and redaction state
   (12-18s).
4. End on: **claude-mem remembers. You see the whole picture.** (18-20s).

## 2. Import without exposing a secret (25 seconds)

1. Show a Cursor Markdown export file (0-4s).
2. Run the Cursor importer with no `--commit` (4-12s).
3. Highlight the redacted candidate (12-18s).
4. Explain that writes happen only after reviewing and adding `--commit`
   (18-25s).

## 3. Back up locally (20 seconds)

1. Show `npm run backup -- --dry-run` (0-6s).
2. Create a backup with a locally set passphrase environment variable (6-14s).
3. Verify the encrypted file (14-18s).
4. End on: **local-first means your memory stays yours.** (18-20s).
