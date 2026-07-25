import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const defaultDataDirectory = join(home, ".claude-mem");

function configuredPath(name, fallback) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

/**
 * Runtime configuration is intentionally environment-based: personal paths,
 * databases and credentials never need to be committed to a repository.
 */
export const config = Object.freeze({
  appName: "You're Always on My Mind",
  bridgePath: configuredPath(
    "YOURE_ALWAYS_ON_MY_MIND_BRIDGE_PATH",
    join(home, ".codex", "skills", "claude-mem-bridge", "scripts", "claude-mem"),
  ),
  dataDirectory: configuredPath("YOURE_ALWAYS_ON_MY_MIND_DATA_DIR", defaultDataDirectory),
  databasePath: configuredPath(
    "YOURE_ALWAYS_ON_MY_MIND_DATABASE_PATH",
    join(configuredPath("YOURE_ALWAYS_ON_MY_MIND_DATA_DIR", defaultDataDirectory), "claude-mem.db"),
  ),
  feedbackPath: configuredPath(
    "YOURE_ALWAYS_ON_MY_MIND_FEEDBACK_PATH",
    join(configuredPath("YOURE_ALWAYS_ON_MY_MIND_DATA_DIR", defaultDataDirectory), "gateway-feedback.jsonl"),
  ),
});
