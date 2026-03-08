import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import { getRepoRoot } from "../git.ts";
import * as log from "../utils/logger.ts";

interface AdapterConfig {
  hooksDir: string;
  files: Record<string, string>;
  configFile?: string;
  configContent?: string;
  mergeConfig?: (existing: Record<string, unknown>, source: Record<string, unknown>) => Record<string, unknown>;
}

const ADAPTERS: Record<string, () => AdapterConfig> = {
  "claude-code": getClaudeCodeConfig,
  "cursor": getCursorConfig,
  "aider": getAiderConfig,
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

  const config = configFn();

  // Create hooks directory
  const hooksPath = join(repoRoot, config.hooksDir);
  mkdirSync(hooksPath, { recursive: true });

  // Write hook files
  for (const [filename, content] of Object.entries(config.files)) {
    const filePath = join(hooksPath, filename);
    writeFileSync(filePath, content, { mode: 0o755 });
    log.info(`Installed: ${filePath}`);
  }

  // Write config file if specified
  if (config.configFile && config.configContent) {
    const configPath = join(repoRoot, config.configFile);
    mkdirSync(join(configPath, ".."), { recursive: true });

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

  const config = configFn();
  const hooksPath = join(repoRoot, config.hooksDir);

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
    mergeConfig: mergeClaudeCodeConfig,
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

function mergeClaudeCodeConfig(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
