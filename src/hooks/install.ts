import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { homedir } from "os";
import { createHash } from "crypto";
import { dirname, isAbsolute, join } from "path";
import { spawnSync } from "bun";
import { getRepoRoot } from "../git.ts";
import * as log from "../utils/logger.ts";

interface AdapterConfig {
  hooksDir: string;
  files: Record<string, string>;
  configFile?: string;
  configContent?: string;
  mergeConfig?: (existing: Record<string, unknown>, source: Record<string, unknown>) => Record<string, unknown>;
}

const ADAPTERS: Record<string, (repoRoot: string) => AdapterConfig> = {
  "claude-code": getClaudeCodeConfig,
  "cursor": getCursorConfig,
  "aider": getAiderConfig,
  "opencode": getOpenCodeConfig,
  "droid": getDroidConfig,
  "auggie": getAuggieConfig,
};

/**
 * Install hooks for the specified adapter.
 */
export function installHooks(adapter = "claude-code", cwd?: string): void {
  const repoRoot = getRepoRoot(cwd);
  const configFn = ADAPTERS[adapter];

  if (!configFn) {
    throw new Error(`Unknown adapter: ${adapter}. Available: ${Object.keys(ADAPTERS).join(", ")}`);
  }

  const config = configFn(repoRoot);

  // Create hooks directory
  const hooksPath = resolveAdapterPath(repoRoot, config.hooksDir);
  mkdirSync(hooksPath, { recursive: true });

  // Write hook files
  for (const [filename, content] of Object.entries(config.files)) {
    const filePath = join(hooksPath, filename);
    writeFileSync(filePath, content, { mode: 0o755 });
    log.info(`Installed: ${filePath}`);
  }

  // Write config file if specified
  if (config.configFile && config.configContent) {
    const configPath = resolveAdapterPath(repoRoot, config.configFile);
    mkdirSync(dirname(configPath), { recursive: true });

    // Merge with existing config if present
    if (existsSync(configPath)) {
      try {
        const existing = JSON.parse(readFileSync(configPath, "utf-8"));
        const newConfig = JSON.parse(config.configContent);
        const merged = config.mergeConfig
          ? config.mergeConfig(existing, newConfig)
          : deepMerge(existing, newConfig);
        writeFileSync(configPath, JSON.stringify(merged, null, 2));
      } catch {
        writeFileSync(configPath, config.configContent);
      }
    } else {
      writeFileSync(configPath, config.configContent);
    }
    log.info(`Config: ${configPath}`);
  }

  // Write rules file
  const rulesDir = join(repoRoot, ".claude", "rules");
  mkdirSync(rulesDir, { recursive: true });
  const rulesPath = join(rulesDir, "git-lanes.md");
  writeFileSync(rulesPath, getAgentRules());
  log.info(`Rules: ${rulesPath}`);

  log.success(`${adapter} hooks installed`);
}

/**
 * Uninstall hooks for the specified adapter.
 */
export function uninstallHooks(adapter = "claude-code", cwd?: string): void {
  const repoRoot = getRepoRoot(cwd);
  const configFn = ADAPTERS[adapter];

  if (!configFn) {
    throw new Error(`Unknown adapter: ${adapter}`);
  }

  const config = configFn(repoRoot);
  const hooksPath = resolveAdapterPath(repoRoot, config.hooksDir);

  // Remove hook files
  for (const filename of Object.keys(config.files)) {
    const filePath = join(hooksPath, filename);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      log.info(`Removed: ${filePath}`);
    }
  }

  log.success(`${adapter} hooks uninstalled`);
}

// ── Adapter Configurations ──

function getClaudeCodeConfig(): AdapterConfig {
  return {
    hooksDir: ".claude/hooks",
    files: {
      "git-lanes-pre-tool": `#!/bin/bash
# git-lanes PreToolUse hook for Claude Code
# Ensures a session is active before file modifications

TOOL_NAME="$1"

# Only intercept file-writing tools
case "$TOOL_NAME" in
  Write|Edit|MultiEdit)
    # Check if a lanes session is active
    if ! git lanes which > /dev/null 2>&1; then
      echo "Warning: No git-lanes session active. Start one with 'git lanes start <name>'"
    fi
    ;;
esac

exit 0
`,
      "git-lanes-post-tool": `#!/bin/bash
# git-lanes PostToolUse hook for Claude Code
# Auto-tracks files after Write/Edit operations

TOOL_NAME="$1"
FILE_PATH="$2"

case "$TOOL_NAME" in
  Write|Edit|MultiEdit)
    if [ -n "$FILE_PATH" ] && git lanes which > /dev/null 2>&1; then
      git lanes track "$FILE_PATH" 2>/dev/null || true
    fi
    ;;
esac

exit 0
`,
      "git-lanes-stop": `#!/bin/bash
# git-lanes Stop hook for Claude Code
# Auto-commits pending work when the session ends

SESSION=$(git lanes which 2>/dev/null | head -1 | awk '{print $NF}')

if [ -n "$SESSION" ]; then
  # Check for uncommitted changes
  WORKTREE=$(git lanes status 2>/dev/null | grep "Worktree:" | awk '{print $NF}')
  if [ -n "$WORKTREE" ] && [ -d "$WORKTREE" ]; then
    cd "$WORKTREE"
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
      git add -A
      git commit -m "WIP: auto-checkpoint on session stop" 2>/dev/null || true
    fi
  fi
fi

exit 0
`,
    },
    configFile: ".claude/settings.json",
    mergeConfig: mergeManagedHookConfig,
    configContent: JSON.stringify({
      hooks: {
        PreToolUse: [createClaudeCommandHookEntry(".claude/hooks/git-lanes-pre-tool")],
        PostToolUse: [createClaudeCommandHookEntry(".claude/hooks/git-lanes-post-tool")],
        Stop: [createClaudeCommandHookEntry(".claude/hooks/git-lanes-stop")],
      },
    }, null, 2),
  };
}

function getCursorConfig(): AdapterConfig {
  return {
    hooksDir: ".cursor/hooks",
    files: {
      "git-lanes-pre-save": `#!/bin/bash
# git-lanes hook for Cursor
# Tracks file saves in the active session

FILE="$1"

if git lanes which > /dev/null 2>&1; then
  git lanes track "$FILE" 2>/dev/null || true
fi

exit 0
`,
    },
  };
}

function getAiderConfig(): AdapterConfig {
  return {
    hooksDir: ".aider/hooks",
    files: {
      "git-lanes-pre-edit": `#!/bin/bash
# git-lanes hook for Aider
# Ensures session is active before edits

if ! git lanes which > /dev/null 2>&1; then
  echo "[git-lanes] No session active. Start one with: git lanes start <name>"
fi

exit 0
`,
    },
  };
}

function getOpenCodeConfig(): AdapterConfig {
  return {
    hooksDir: ".opencode/plugins",
    files: {
      "git-lanes.js": `import { spawnSync } from "bun";

const FILE_TOOLS = new Set(["edit", "write", "patch", "multiedit"]);
const decoder = new TextDecoder();

function outputText(value) {
  return value ? decoder.decode(value).trim() : "";
}

function run(args, cwd) {
  return spawnSync(args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

function hasSession(cwd) {
  return run(["git", "lanes", "which"], cwd).exitCode === 0;
}

function maybeCommit(cwd) {
  const status = run(["git", "status", "--porcelain"], cwd);
  if (status.exitCode !== 0 || outputText(status.stdout) === "") {
    return;
  }

  spawnSync(["git", "add", "-A"], { cwd, stdio: ["ignore", "ignore", "ignore"] });
  spawnSync(["git", "commit", "-m", "WIP: auto-checkpoint on session stop"], {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function extractPaths(output) {
  const paths = [];

  if (typeof output?.args?.filePath === "string") {
    paths.push(output.args.filePath);
  }

  if (typeof output?.args?.path === "string") {
    paths.push(output.args.path);
  }

  return [...new Set(paths.filter((value) => typeof value === "string" && value.length > 0))];
}

export const GitLanesPlugin = async ({ directory, worktree }) => {
  const cwd = typeof worktree === "string" && worktree.length > 0 ? worktree : directory;

  return {
    "tool.execute.after": async (input, output) => {
      if (!FILE_TOOLS.has(input.tool) || !hasSession(cwd)) {
        return;
      }

      for (const filePath of extractPaths(output)) {
        spawnSync(["git", "lanes", "track", filePath], {
          cwd,
          stdio: ["ignore", "ignore", "ignore"],
        });
      }
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle" || !hasSession(cwd)) {
        return;
      }

      maybeCommit(cwd);
    },
  };
};
`,
    },
  };
}

function getDroidConfig(): AdapterConfig {
  return {
    hooksDir: ".factory/hooks",
    files: {
      "git-lanes-pre-tool.sh": getDroidPreToolScript(),
      "git-lanes-post-tool.sh": getDroidPostToolScript(),
      "git-lanes-stop.sh": getDroidStopScript(),
    },
    configFile: ".factory/settings.json",
    mergeConfig: mergeManagedHookConfig,
    configContent: JSON.stringify({
      hooks: {
        PreToolUse: [createManagedCommandHookEntry('"$FACTORY_PROJECT_DIR"/.factory/hooks/git-lanes-pre-tool.sh', "Edit|Create")],
        PostToolUse: [createManagedCommandHookEntry('"$FACTORY_PROJECT_DIR"/.factory/hooks/git-lanes-post-tool.sh', "Edit|Create")],
        Stop: [createManagedCommandHookEntry('"$FACTORY_PROJECT_DIR"/.factory/hooks/git-lanes-stop.sh')],
      },
    }, null, 2),
  };
}

function getAuggieConfig(repoRoot: string): AdapterConfig {
  const commonDir = getGitCommonDir(repoRoot);
  const repoId = getRepoId(commonDir);
  const userHome = getUserHomeDir();
  const hooksDir = join(userHome, ".augment", "hooks");
  const preTool = `git-lanes-${repoId}-pre-tool.sh`;
  const postTool = `git-lanes-${repoId}-post-tool.sh`;
  const stopTool = `git-lanes-${repoId}-stop.sh`;
  const preToolPath = join(hooksDir, preTool);
  const postToolPath = join(hooksDir, postTool);
  const stopToolPath = join(hooksDir, stopTool);

  return {
    hooksDir,
    files: {
      [preTool]: getAuggiePreToolScript(commonDir),
      [postTool]: getAuggiePostToolScript(commonDir),
      [stopTool]: getAuggieStopScript(commonDir),
    },
    configFile: join(userHome, ".augment", "settings.json"),
    mergeConfig: mergeManagedHookConfig,
    configContent: JSON.stringify({
      hooks: {
        PreToolUse: [createManagedCommandHookEntry(preToolPath, "save-file|str-replace-editor|remove-files")],
        PostToolUse: [createManagedCommandHookEntry(postToolPath, "save-file|str-replace-editor|remove-files")],
        Stop: [createManagedCommandHookEntry(stopToolPath)],
      },
    }, null, 2),
  };
}

function getAgentRules(): string {
  return `# git-lanes Workflow Rules

When working in this repository, follow these rules:

1. **Always start a session** before editing files:
   \`git lanes start <descriptive-name>\`

2. **Use descriptive session names** that reflect the task:
   Good: \`fix-auth-bug\`, \`add-search-feature\`
   Bad: \`session1\`, \`test\`

3. **Commit frequently** with clear messages:
   \`git lanes commit -m "add input validation for login form"\`

4. **Check for conflicts** before merging:
   \`git lanes conflicts\`

5. **Never end a session you did not create.**

6. **Run tests** before ending a session:
   \`git lanes test\`

7. **End the session** when your task is complete:
   \`git lanes end -m "completed: add search feature"\`
`;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const targetVal = target[key];
    const sourceVal = source[key];

    if (
      targetVal && sourceVal &&
      typeof targetVal === "object" && typeof sourceVal === "object" &&
      !Array.isArray(targetVal) && !Array.isArray(sourceVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }

  return result;
}

function createClaudeCommandHookEntry(command: string): Record<string, unknown> {
  return {
    hooks: [
      {
        type: "command",
        command,
      },
    ],
  };
}

function createManagedCommandHookEntry(command: string, matcher?: string): Record<string, unknown> {
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: "command",
        command,
      },
    ],
  };
}

function mergeManagedHookConfig(
  existing: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const sourceWithoutHooks = { ...source };
  delete sourceWithoutHooks.hooks;

  const merged = deepMerge(existing, sourceWithoutHooks);
  const existingHooks = asRecord(existing.hooks);
  const sourceHooks = asRecord(source.hooks);
  const mergedHooks: Record<string, unknown> = { ...existingHooks };

  for (const [eventName, sourceEntries] of Object.entries(sourceHooks)) {
    const desiredEntries = Array.isArray(sourceEntries) ? sourceEntries : [];
    const managedCommands = new Set(getHookCommands(desiredEntries));
    const currentEntries = Array.isArray(existingHooks[eventName]) ? existingHooks[eventName] : [];

    const sanitizedEntries = currentEntries
      .map((entry) => removeManagedCommandsFromHookEntry(entry, managedCommands))
      .filter((entry): entry is unknown => entry !== null);

    mergedHooks[eventName] = [...sanitizedEntries, ...desiredEntries];
  }

  return {
    ...merged,
    hooks: mergedHooks,
  };
}

function removeManagedCommandsFromHookEntry(
  entry: unknown,
  managedCommands: Set<string>,
): unknown | null {
  if (!isRecord(entry)) {
    return entry;
  }

  if (typeof entry.command === "string" && managedCommands.has(entry.command)) {
    return null;
  }

  if (!Array.isArray(entry.hooks)) {
    return entry;
  }

  let removed = false;
  const remainingHooks = entry.hooks.filter((hook) => {
    if (isRecord(hook) && typeof hook.command === "string" && managedCommands.has(hook.command)) {
      removed = true;
      return false;
    }

    return true;
  });

  if (!removed) {
    return entry;
  }

  if (remainingHooks.length === 0) {
    return null;
  }

  return {
    ...entry,
    hooks: remainingHooks,
  };
}

function getHookCommands(entries: unknown[]): string[] {
  const commands = new Set<string>();

  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }

    if (typeof entry.command === "string") {
      commands.add(entry.command);
    }

    if (!Array.isArray(entry.hooks)) {
      continue;
    }

    for (const hook of entry.hooks) {
      if (isRecord(hook) && typeof hook.command === "string") {
        commands.add(hook.command);
      }
    }
  }

  return [...commands];
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function resolveAdapterPath(repoRoot: string, targetPath: string): string {
  return isAbsolute(targetPath) ? targetPath : join(repoRoot, targetPath);
}

function getGitCommonDir(repoRoot: string): string {
  const result = spawnSync(["git", "rev-parse", "--git-common-dir"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "ignore"],
  });

  const value = decodeOutput(result.stdout);
  if (result.exitCode !== 0 || value === "") {
    return repoRoot;
  }

  return isAbsolute(value) ? value : join(repoRoot, value);
}

function getRepoId(commonDir: string): string {
  return createHash("sha1").update(commonDir).digest("hex").slice(0, 10);
}

function getUserHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

function decodeOutput(value: { toString(): string } | Uint8Array | undefined): string {
  return value ? value.toString().trim() : "";
}

function getDroidPreToolScript(): string {
  return `#!/usr/bin/env bun
import { readFileSync } from "fs";
import { spawnSync } from "bun";

function readEvent() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function hasSession(cwd) {
  return spawnSync(["git", "lanes", "which"], { cwd, stdio: ["ignore", "ignore", "ignore"] }).exitCode === 0;
}

const event = readEvent();
const cwd = typeof event.cwd === "string" ? event.cwd : process.cwd();
const toolName = typeof event.tool_name === "string" ? event.tool_name : "";

if ((toolName === "Create" || toolName === "Edit") && !hasSession(cwd)) {
  console.error("[git-lanes] No session active. Start one with: git lanes start <name>");
}
`;
}

function getDroidPostToolScript(): string {
  return `#!/usr/bin/env bun
import { readFileSync } from "fs";
import { spawnSync } from "bun";

function readEvent() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function hasSession(cwd) {
  return spawnSync(["git", "lanes", "which"], { cwd, stdio: ["ignore", "ignore", "ignore"] }).exitCode === 0;
}

const event = readEvent();
const cwd = typeof event.cwd === "string" ? event.cwd : process.cwd();
const toolName = typeof event.tool_name === "string" ? event.tool_name : "";

if ((toolName !== "Create" && toolName !== "Edit") || !hasSession(cwd)) {
  process.exit(0);
}

const filePath = typeof event.tool_response?.filePath === "string"
  ? event.tool_response.filePath
  : typeof event.tool_input?.file_path === "string"
    ? event.tool_input.file_path
    : "";

if (filePath !== "") {
  spawnSync(["git", "lanes", "track", filePath], { cwd, stdio: ["ignore", "ignore", "ignore"] });
}
`;
}

function getDroidStopScript(): string {
  return `#!/usr/bin/env bun
import { readFileSync } from "fs";
import { spawnSync } from "bun";

const decoder = new TextDecoder();

function readEvent() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function outputText(value) {
  return value ? decoder.decode(value).trim() : "";
}

function run(args, cwd) {
  return spawnSync(args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

function hasSession(cwd) {
  return run(["git", "lanes", "which"], cwd).exitCode === 0;
}

const event = readEvent();
const cwd = typeof event.cwd === "string" ? event.cwd : process.cwd();

if (!hasSession(cwd)) {
  process.exit(0);
}

const status = run(["git", "status", "--porcelain"], cwd);
if (status.exitCode !== 0 || outputText(status.stdout) === "") {
  process.exit(0);
}

spawnSync(["git", "add", "-A"], { cwd, stdio: ["ignore", "ignore", "ignore"] });
spawnSync(["git", "commit", "-m", "WIP: auto-checkpoint on session stop"], {
  cwd,
  stdio: ["ignore", "ignore", "ignore"],
});
`;
}

function getAuggiePreToolScript(commonDir: string): string {
  return `#!/usr/bin/env bun
import { readFileSync } from "fs";
import { isAbsolute, join } from "path";
import { spawnSync } from "bun";

const EXPECTED_COMMON_DIR = ${JSON.stringify(commonDir)};
const decoder = new TextDecoder();

function readEvent() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function outputText(value) {
  return value ? decoder.decode(value).trim() : "";
}

function getWorkspaceRoot(event) {
  return Array.isArray(event.workspace_roots) && typeof event.workspace_roots[0] === "string"
    ? event.workspace_roots[0]
    : process.cwd();
}

function getCommonDir(cwd) {
  const result = spawnSync(["git", "rev-parse", "--git-common-dir"], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const value = outputText(result.stdout);
  if (result.exitCode !== 0 || value === "") {
    return "";
  }
  return isAbsolute(value) ? value : join(cwd, value);
}

function hasSession(cwd) {
  return spawnSync(["git", "lanes", "which"], { cwd, stdio: ["ignore", "ignore", "ignore"] }).exitCode === 0;
}

const event = readEvent();
const cwd = getWorkspaceRoot(event);
const toolName = typeof event.tool_name === "string" ? event.tool_name : "";

if (getCommonDir(cwd) !== EXPECTED_COMMON_DIR) {
  process.exit(0);
}

if ((toolName === "save-file" || toolName === "str-replace-editor" || toolName === "remove-files") && !hasSession(cwd)) {
  console.error("[git-lanes] No session active. Start one with: git lanes start <name>");
}
`;
}

function getAuggiePostToolScript(commonDir: string): string {
  return `#!/usr/bin/env bun
import { readFileSync } from "fs";
import { isAbsolute, join } from "path";
import { spawnSync } from "bun";

const EXPECTED_COMMON_DIR = ${JSON.stringify(commonDir)};
const decoder = new TextDecoder();

function readEvent() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function outputText(value) {
  return value ? decoder.decode(value).trim() : "";
}

function getWorkspaceRoot(event) {
  return Array.isArray(event.workspace_roots) && typeof event.workspace_roots[0] === "string"
    ? event.workspace_roots[0]
    : process.cwd();
}

function getCommonDir(cwd) {
  const result = spawnSync(["git", "rev-parse", "--git-common-dir"], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const value = outputText(result.stdout);
  if (result.exitCode !== 0 || value === "") {
    return "";
  }
  return isAbsolute(value) ? value : join(cwd, value);
}

function hasSession(cwd) {
  return spawnSync(["git", "lanes", "which"], { cwd, stdio: ["ignore", "ignore", "ignore"] }).exitCode === 0;
}

const event = readEvent();
const cwd = getWorkspaceRoot(event);

if (getCommonDir(cwd) !== EXPECTED_COMMON_DIR || !hasSession(cwd)) {
  process.exit(0);
}

const changes = Array.isArray(event.file_changes) ? event.file_changes : [];
const paths = [...new Set(changes
  .map((change) => typeof change?.path === "string" ? change.path : "")
  .filter((value) => value !== ""))];

for (const filePath of paths) {
  spawnSync(["git", "lanes", "track", filePath], { cwd, stdio: ["ignore", "ignore", "ignore"] });
}
`;
}

function getAuggieStopScript(commonDir: string): string {
  return `#!/usr/bin/env bun
import { readFileSync } from "fs";
import { isAbsolute, join } from "path";
import { spawnSync } from "bun";

const EXPECTED_COMMON_DIR = ${JSON.stringify(commonDir)};
const decoder = new TextDecoder();

function readEvent() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function outputText(value) {
  return value ? decoder.decode(value).trim() : "";
}

function getWorkspaceRoot(event) {
  return Array.isArray(event.workspace_roots) && typeof event.workspace_roots[0] === "string"
    ? event.workspace_roots[0]
    : process.cwd();
}

function getCommonDir(cwd) {
  const result = spawnSync(["git", "rev-parse", "--git-common-dir"], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const value = outputText(result.stdout);
  if (result.exitCode !== 0 || value === "") {
    return "";
  }
  return isAbsolute(value) ? value : join(cwd, value);
}

function run(args, cwd) {
  return spawnSync(args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

function hasSession(cwd) {
  return run(["git", "lanes", "which"], cwd).exitCode === 0;
}

const event = readEvent();
const cwd = getWorkspaceRoot(event);

if (getCommonDir(cwd) !== EXPECTED_COMMON_DIR || !hasSession(cwd)) {
  process.exit(0);
}

const status = run(["git", "status", "--porcelain"], cwd);
if (status.exitCode !== 0 || outputText(status.stdout) === "") {
  process.exit(0);
}

spawnSync(["git", "add", "-A"], { cwd, stdio: ["ignore", "ignore", "ignore"] });
spawnSync(["git", "commit", "-m", "WIP: auto-checkpoint on session stop"], {
  cwd,
  stdio: ["ignore", "ignore", "ignore"],
});
`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
