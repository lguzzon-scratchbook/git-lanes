import {afterEach, beforeEach, describe, expect, test} from "bun:test"
import {branchExists} from "../../src/git.ts"
import {loadManifest} from "../../src/manifest.ts"
import {abortSession, listSessions, startSession} from "../../src/session.ts"
import {createTempRepo, removeTempRepo} from "../helpers/temp-repo.ts"

describe("session lifecycle", () => {
  let repoPath: string

  beforeEach(() => {
    repoPath = createTempRepo("lifecycle-test")
  })

  afterEach(() => {
    removeTempRepo(repoPath)
  })

  test("start creates session with branch, worktree, and manifest", () => {
    const info = startSession("my-feature", repoPath)

    expect(info.name).toBe("my-feature")
    expect(info.branch).toBe("lanes/my-feature")
    expect(info.worktreePath).toContain("my-feature")
    expect(info.changesets).toEqual([])

    // Verify manifest was created
    const manifest = loadManifest("my-feature", repoPath)
    expect(manifest).not.toBeNull()

    // Verify branch exists
    expect(branchExists("lanes/my-feature", repoPath)).toBe(true)
  })

  test("start rejects duplicate session names", () => {
    startSession("duplicate", repoPath)
    expect(() => startSession("duplicate", repoPath)).toThrow("already exists")
  })

  test("start validates session name", () => {
    expect(() => startSession("", repoPath)).toThrow()
    expect(() => startSession("../evil", repoPath)).toThrow()
    expect(() => startSession("; rm -rf /", repoPath)).toThrow()
  })

  test("abort removes everything", () => {
    startSession("to-abort", repoPath)
    expect(loadManifest("to-abort", repoPath)).not.toBeNull()

    abortSession("to-abort", repoPath)

    expect(loadManifest("to-abort", repoPath)).toBeNull()
    expect(branchExists("lanes/to-abort", repoPath)).toBe(false)
  })

  test("list shows all active sessions", () => {
    startSession("session-1", repoPath)
    startSession("session-2", repoPath)

    const sessions = listSessions(repoPath)
    expect(sessions.length).toBe(2)
    expect(sessions.map(s => s.name).sort()).toEqual(["session-1", "session-2"])
  })
})
