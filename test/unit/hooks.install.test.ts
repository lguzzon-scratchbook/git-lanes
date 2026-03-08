import { test, expect, describe } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { withTempRepo } from "../helpers/temp-repo.ts";
import { installHooks } from "../../src/hooks/install.ts";

const PRE_TOOL = ".claude/hooks/git-lanes-pre-tool";
const POST_TOOL = ".claude/hooks/git-lanes-post-tool";
const STOP_TOOL = ".claude/hooks/git-lanes-stop";

describe("Claude hook installation", () => {
  test("installs Claude hooks with the nested settings format", async () => {
    await withTempRepo((repoPath) => {
      installHooks("claude-code", repoPath);

      const settings = readSettings(repoPath);
      expect(countCommand(settings, "PreToolUse", PRE_TOOL)).toBe(1);
      expect(countCommand(settings, "PostToolUse", POST_TOOL)).toBe(1);
      expect(countCommand(settings, "Stop", STOP_TOOL)).toBe(1);
      expect(hasCanonicalCommandEntry(settings, "PreToolUse", PRE_TOOL)).toBe(true);
      expect(hasCanonicalCommandEntry(settings, "PostToolUse", POST_TOOL)).toBe(true);
      expect(hasCanonicalCommandEntry(settings, "Stop", STOP_TOOL)).toBe(true);
      expect(existsSync(join(repoPath, PRE_TOOL))).toBe(true);
      expect(existsSync(join(repoPath, POST_TOOL))).toBe(true);
      expect(existsSync(join(repoPath, STOP_TOOL))).toBe(true);
    }, "hooks-install-fresh");
  });

  test("updates existing Claude settings without removing unrelated hooks", async () => {
    await withTempRepo((repoPath) => {
      const settingsPath = join(repoPath, ".claude", "settings.json");
      mkdirSync(join(repoPath, ".claude"), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "./custom-pre" }] }],
          PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "./custom-read" }] }],
          Stop: [{ hooks: [{ type: "command", command: "./custom-stop" }] }],
        },
        permissions: { allow: ["Bash(custom)"] },
      }, null, 2));

      installHooks("claude-code", repoPath);

      const settings = readSettings(repoPath);
      expect(countCommand(settings, "PreToolUse", "./custom-pre")).toBe(1);
      expect(countCommand(settings, "PostToolUse", "./custom-read")).toBe(1);
      expect(countCommand(settings, "Stop", "./custom-stop")).toBe(1);
      expect(countCommand(settings, "PreToolUse", PRE_TOOL)).toBe(1);
      expect(countCommand(settings, "PostToolUse", POST_TOOL)).toBe(1);
      expect(countCommand(settings, "Stop", STOP_TOOL)).toBe(1);
      expect((settings.permissions as { allow: string[] }).allow).toEqual(["Bash(custom)"]);
    }, "hooks-install-update");
  });

  test("reinstall normalizes legacy or duplicate git-lanes hook entries", async () => {
    await withTempRepo((repoPath) => {
      const settingsPath = join(repoPath, ".claude", "settings.json");
      mkdirSync(join(repoPath, ".claude"), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          PreToolUse: [
            { command: PRE_TOOL },
            { hooks: [{ type: "command", command: PRE_TOOL }] },
            { hooks: [{ command: PRE_TOOL }] },
          ],
          PostToolUse: [
            { hooks: [{ type: "command", command: POST_TOOL }, { type: "command", command: "./custom-post" }] },
          ],
          Stop: [
            { hooks: [{ type: "command", command: STOP_TOOL }] },
            { hooks: [{ type: "command", command: STOP_TOOL }] },
          ],
        },
      }, null, 2));

      installHooks("claude-code", repoPath);

      const settings = readSettings(repoPath);
      expect(countCommand(settings, "PreToolUse", PRE_TOOL)).toBe(1);
      expect(countCommand(settings, "PostToolUse", POST_TOOL)).toBe(1);
      expect(countCommand(settings, "Stop", STOP_TOOL)).toBe(1);
      expect(countCommand(settings, "PostToolUse", "./custom-post")).toBe(1);
      expect(hasCanonicalCommandEntry(settings, "PreToolUse", PRE_TOOL)).toBe(true);
      expect(hasCanonicalCommandEntry(settings, "PostToolUse", POST_TOOL)).toBe(true);
      expect(hasCanonicalCommandEntry(settings, "Stop", STOP_TOOL)).toBe(true);
    }, "hooks-install-dedupe");
  });
});

function readSettings(repoPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoPath, ".claude", "settings.json"), "utf-8"));
}

function countCommand(settings: Record<string, unknown>, eventName: string, command: string): number {
  return getEntries(settings, eventName).flatMap(getCommands).filter((item) => item === command).length;
}

function hasCanonicalCommandEntry(settings: Record<string, unknown>, eventName: string, command: string): boolean {
  return getEntries(settings, eventName).some((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks) || entry.hooks.length !== 1) {
      return false;
    }

    const [hook] = entry.hooks;
    return isRecord(hook) && hook.type === "command" && hook.command === command;
  });
}

function getEntries(settings: Record<string, unknown>, eventName: string): unknown[] {
  const hooks = settings.hooks;
  if (!isRecord(hooks)) {
    return [];
  }

  const entries = hooks[eventName];
  return Array.isArray(entries) ? entries : [];
}

function getCommands(entry: unknown): string[] {
  if (!isRecord(entry)) {
    return [];
  }

  const commands: string[] = [];
  if (typeof entry.command === "string") {
    commands.push(entry.command);
  }

  if (!Array.isArray(entry.hooks)) {
    return commands;
  }

  for (const hook of entry.hooks) {
    if (isRecord(hook) && typeof hook.command === "string") {
      commands.push(hook.command);
    }
  }

  return commands;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}