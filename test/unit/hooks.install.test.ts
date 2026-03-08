import {describe, expect, test} from "bun:test"
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import {installHooks} from "../../src/hooks/install.ts"
import {withTempRepo} from "../helpers/temp-repo.ts"

const PRE_TOOL = ".claude/hooks/git-lanes-pre-tool"
const POST_TOOL = ".claude/hooks/git-lanes-post-tool"
const STOP_TOOL = ".claude/hooks/git-lanes-stop"
const DROID_PRE_TOOL =
  '"$FACTORY_PROJECT_DIR"/.factory/hooks/git-lanes-pre-tool.sh'
const DROID_POST_TOOL =
  '"$FACTORY_PROJECT_DIR"/.factory/hooks/git-lanes-post-tool.sh'
const DROID_STOP_TOOL =
  '"$FACTORY_PROJECT_DIR"/.factory/hooks/git-lanes-stop.sh'

describe("Claude hook installation", () => {
  test("installs Claude hooks with the nested settings format", async () => {
    await withTempRepo(repoPath => {
      installHooks("claude-code", repoPath)

      const settings = readSettings(repoPath)
      expect(countCommand(settings, "PreToolUse", PRE_TOOL)).toBe(1)
      expect(countCommand(settings, "PostToolUse", POST_TOOL)).toBe(1)
      expect(countCommand(settings, "Stop", STOP_TOOL)).toBe(1)
      expect(hasCanonicalCommandEntry(settings, "PreToolUse", PRE_TOOL)).toBe(
        true
      )
      expect(hasCanonicalCommandEntry(settings, "PostToolUse", POST_TOOL)).toBe(
        true
      )
      expect(hasCanonicalCommandEntry(settings, "Stop", STOP_TOOL)).toBe(true)
      expect(existsSync(join(repoPath, PRE_TOOL))).toBe(true)
      expect(existsSync(join(repoPath, POST_TOOL))).toBe(true)
      expect(existsSync(join(repoPath, STOP_TOOL))).toBe(true)
    }, "hooks-install-fresh")
  })

  test("updates existing Claude settings without removing unrelated hooks", async () => {
    await withTempRepo(repoPath => {
      const settingsPath = join(repoPath, ".claude", "settings.json")
      mkdirSync(join(repoPath, ".claude"), {recursive: true})
      writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: "Write",
                  hooks: [{type: "command", command: "./custom-pre"}]
                }
              ],
              PostToolUse: [
                {
                  matcher: "Read",
                  hooks: [{type: "command", command: "./custom-read"}]
                }
              ],
              Stop: [{hooks: [{type: "command", command: "./custom-stop"}]}]
            },
            permissions: {allow: ["Bash(custom)"]}
          },
          null,
          2
        )
      )

      installHooks("claude-code", repoPath)

      const settings = readSettings(repoPath)
      expect(countCommand(settings, "PreToolUse", "./custom-pre")).toBe(1)
      expect(countCommand(settings, "PostToolUse", "./custom-read")).toBe(1)
      expect(countCommand(settings, "Stop", "./custom-stop")).toBe(1)
      expect(countCommand(settings, "PreToolUse", PRE_TOOL)).toBe(1)
      expect(countCommand(settings, "PostToolUse", POST_TOOL)).toBe(1)
      expect(countCommand(settings, "Stop", STOP_TOOL)).toBe(1)
      expect((settings.permissions as {allow: string[]}).allow).toEqual([
        "Bash(custom)"
      ])
    }, "hooks-install-update")
  })

  test("reinstall normalizes legacy or duplicate git-lanes hook entries", async () => {
    await withTempRepo(repoPath => {
      const settingsPath = join(repoPath, ".claude", "settings.json")
      mkdirSync(join(repoPath, ".claude"), {recursive: true})
      writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {command: PRE_TOOL},
                {hooks: [{type: "command", command: PRE_TOOL}]},
                {hooks: [{command: PRE_TOOL}]}
              ],
              PostToolUse: [
                {
                  hooks: [
                    {type: "command", command: POST_TOOL},
                    {type: "command", command: "./custom-post"}
                  ]
                }
              ],
              Stop: [
                {hooks: [{type: "command", command: STOP_TOOL}]},
                {hooks: [{type: "command", command: STOP_TOOL}]}
              ]
            }
          },
          null,
          2
        )
      )

      installHooks("claude-code", repoPath)

      const settings = readSettings(repoPath)
      expect(countCommand(settings, "PreToolUse", PRE_TOOL)).toBe(1)
      expect(countCommand(settings, "PostToolUse", POST_TOOL)).toBe(1)
      expect(countCommand(settings, "Stop", STOP_TOOL)).toBe(1)
      expect(countCommand(settings, "PostToolUse", "./custom-post")).toBe(1)
      expect(hasCanonicalCommandEntry(settings, "PreToolUse", PRE_TOOL)).toBe(
        true
      )
      expect(hasCanonicalCommandEntry(settings, "PostToolUse", POST_TOOL)).toBe(
        true
      )
      expect(hasCanonicalCommandEntry(settings, "Stop", STOP_TOOL)).toBe(true)
    }, "hooks-install-dedupe")
  })
})

describe("OpenCode hook installation", () => {
  test("installs a project plugin with verified hook entrypoints", async () => {
    await withTempRepo(repoPath => {
      installHooks("opencode", repoPath)

      const pluginPath = join(repoPath, ".opencode", "plugins", "git-lanes.js")
      const plugin = readFileSync(pluginPath, "utf-8")

      expect(existsSync(pluginPath)).toBe(true)
      expect(plugin).toContain("tool.execute.after")
      expect(plugin).toContain("session.idle")
      expect(plugin).toContain('spawnSync(["git", "lanes", "track", filePath]')
    }, "hooks-install-opencode")
  })
})

describe("Droid hook installation", () => {
  test("installs Droid hooks and project settings", async () => {
    await withTempRepo(repoPath => {
      installHooks("droid", repoPath)

      const settings = readJson(join(repoPath, ".factory", "settings.json"))
      expect(countCommand(settings, "PreToolUse", DROID_PRE_TOOL)).toBe(1)
      expect(countCommand(settings, "PostToolUse", DROID_POST_TOOL)).toBe(1)
      expect(countCommand(settings, "Stop", DROID_STOP_TOOL)).toBe(1)
      expect(
        existsSync(join(repoPath, ".factory", "hooks", "git-lanes-pre-tool.sh"))
      ).toBe(true)
      expect(
        existsSync(
          join(repoPath, ".factory", "hooks", "git-lanes-post-tool.sh")
        )
      ).toBe(true)
      expect(
        existsSync(join(repoPath, ".factory", "hooks", "git-lanes-stop.sh"))
      ).toBe(true)
    }, "hooks-install-droid-fresh")
  })

  test("updates existing Droid settings without duplicating managed commands", async () => {
    await withTempRepo(repoPath => {
      const settingsPath = join(repoPath, ".factory", "settings.json")
      mkdirSync(join(repoPath, ".factory"), {recursive: true})
      writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: "Create",
                  hooks: [{type: "command", command: "./custom-pre"}]
                },
                {
                  matcher: "Edit|Create",
                  hooks: [{type: "command", command: DROID_PRE_TOOL}]
                }
              ],
              PostToolUse: [
                {hooks: [{type: "command", command: DROID_POST_TOOL}]},
                {hooks: [{type: "command", command: "./custom-post"}]}
              ],
              Stop: [{hooks: [{type: "command", command: DROID_STOP_TOOL}]}]
            }
          },
          null,
          2
        )
      )

      installHooks("droid", repoPath)

      const settings = readJson(settingsPath)
      expect(countCommand(settings, "PreToolUse", "./custom-pre")).toBe(1)
      expect(countCommand(settings, "PostToolUse", "./custom-post")).toBe(1)
      expect(countCommand(settings, "PreToolUse", DROID_PRE_TOOL)).toBe(1)
      expect(countCommand(settings, "PostToolUse", DROID_POST_TOOL)).toBe(1)
      expect(countCommand(settings, "Stop", DROID_STOP_TOOL)).toBe(1)
    }, "hooks-install-droid-update")
  })
})

describe("Auggie hook installation", () => {
  test("installs repo-scoped Auggie hooks into user settings", async () => {
    await withTempRepo(repoPath => {
      const fakeHome = join(repoPath, ".fake-home")
      mkdirSync(fakeHome, {recursive: true})

      withEnv("HOME", fakeHome, () => {
        installHooks("auggie", repoPath)

        const settingsPath = join(fakeHome, ".augment", "settings.json")
        const settings = readJson(settingsPath)
        const preCommand = findManagedCommand(settings, "PreToolUse", fakeHome)
        const postCommand = findManagedCommand(
          settings,
          "PostToolUse",
          fakeHome
        )
        const stopCommand = findManagedCommand(settings, "Stop", fakeHome)

        expect(preCommand).not.toBe("")
        expect(postCommand).not.toBe("")
        expect(stopCommand).not.toBe("")
        expect(existsSync(preCommand)).toBe(true)
        expect(existsSync(postCommand)).toBe(true)
        expect(existsSync(stopCommand)).toBe(true)
      })
    }, "hooks-install-auggie-fresh")
  })

  test("updates existing Auggie settings without duplicating repo-managed commands", async () => {
    await withTempRepo(repoPath => {
      const fakeHome = join(repoPath, ".fake-home")
      const augmentDir = join(fakeHome, ".augment")
      mkdirSync(augmentDir, {recursive: true})

      withEnv("HOME", fakeHome, () => {
        installHooks("auggie", repoPath)

        const settingsPath = join(augmentDir, "settings.json")
        const installed = readJson(settingsPath)
        const preCommand = findManagedCommand(installed, "PreToolUse", fakeHome)
        const postCommand = findManagedCommand(
          installed,
          "PostToolUse",
          fakeHome
        )
        const stopCommand = findManagedCommand(installed, "Stop", fakeHome)

        writeFileSync(
          settingsPath,
          JSON.stringify(
            {
              hooks: {
                PreToolUse: [
                  {hooks: [{type: "command", command: preCommand}]},
                  {hooks: [{type: "command", command: "./custom-pre"}]}
                ],
                PostToolUse: [
                  {hooks: [{type: "command", command: postCommand}]},
                  {hooks: [{type: "command", command: "./custom-post"}]}
                ],
                Stop: [{hooks: [{type: "command", command: stopCommand}]}]
              },
              permissions: {mode: "strict"}
            },
            null,
            2
          )
        )

        installHooks("auggie", repoPath)

        const settings = readJson(settingsPath)
        expect(countCommand(settings, "PreToolUse", "./custom-pre")).toBe(1)
        expect(countCommand(settings, "PostToolUse", "./custom-post")).toBe(1)
        expect(countCommand(settings, "PreToolUse", preCommand)).toBe(1)
        expect(countCommand(settings, "PostToolUse", postCommand)).toBe(1)
        expect(countCommand(settings, "Stop", stopCommand)).toBe(1)
        expect((settings.permissions as {mode: string}).mode).toBe("strict")
      })
    }, "hooks-install-auggie-update")
  })
})

function readSettings(repoPath: string): Record<string, unknown> {
  return readJson(join(repoPath, ".claude", "settings.json"))
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8"))
}

function countCommand(
  settings: Record<string, unknown>,
  eventName: string,
  command: string
): number {
  return getEntries(settings, eventName)
    .flatMap(getCommands)
    .filter(item => item === command).length
}

function hasCanonicalCommandEntry(
  settings: Record<string, unknown>,
  eventName: string,
  command: string
): boolean {
  return getEntries(settings, eventName).some(entry => {
    if (
      !isRecord(entry) ||
      !Array.isArray(entry.hooks) ||
      entry.hooks.length !== 1
    ) {
      return false
    }

    const [hook] = entry.hooks
    return isRecord(hook) && hook.type === "command" && hook.command === command
  })
}

function getEntries(
  settings: Record<string, unknown>,
  eventName: string
): unknown[] {
  const hooks = settings.hooks
  if (!isRecord(hooks)) {
    return []
  }

  const entries = hooks[eventName]
  return Array.isArray(entries) ? entries : []
}

function getCommands(entry: unknown): string[] {
  if (!isRecord(entry)) {
    return []
  }

  const commands: string[] = []
  if (typeof entry.command === "string") {
    commands.push(entry.command)
  }

  if (!Array.isArray(entry.hooks)) {
    return commands
  }

  for (const hook of entry.hooks) {
    if (isRecord(hook) && typeof hook.command === "string") {
      commands.push(hook.command)
    }
  }

  return commands
}

function findManagedCommand(
  settings: Record<string, unknown>,
  eventName: string,
  fakeHome: string
): string {
  return (
    getEntries(settings, eventName)
      .flatMap(getCommands)
      .find(command =>
        command.startsWith(join(fakeHome, ".augment", "hooks", "git-lanes-"))
      ) ?? ""
  )
}

function withEnv<T>(name: string, value: string, fn: () => T): T {
  const previous = process.env[name]
  process.env[name] = value
  try {
    return fn()
  } finally {
    if (previous === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = previous
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
