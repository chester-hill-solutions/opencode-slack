import { describe, expect, test, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../packages/bot/src/state"

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function tempStore() {
  dir = mkdtempSync(join(tmpdir(), "opencode-slack-test-"))
  return new StateStore(join(dir, "state.json"))
}

describe("StateStore", () => {
  test("round-trips thread -> session mappings", () => {
    const store = tempStore()
    store.setByKey("C123:111.0001", "ses_abc", "111.0001")
    expect(store.getByKey("C123:111.0001")).toEqual({ sessionID: "ses_abc", replyTs: "111.0001" })
    expect(store.getThread("ses_abc")).toEqual({ channel: "C123", replyTs: "111.0001" })
  })

  test("persists to disk and reloads", () => {
    const store = tempStore()
    store.setByKey("C999:222.0002", "ses_xyz", "222.0002")
    const path = join(dir!, "state.json")
    const onDisk = JSON.parse(readFileSync(path, "utf8"))
    expect(onDisk.threads["C999:222.0002"]).toEqual({ sessionID: "ses_xyz", replyTs: "222.0002" })

    const reloaded = new StateStore(path)
    expect(reloaded.getByKey("C999:222.0002")).toEqual({ sessionID: "ses_xyz", replyTs: "222.0002" })
    expect(reloaded.getThread("ses_xyz")).toEqual({ channel: "C999", replyTs: "222.0002" })
  })

  test("DM mappings have no reply thread", () => {
    const store = tempStore()
    store.setByKey("D123:dm", "ses_dm")
    expect(store.getByKey("D123:dm")).toEqual({ sessionID: "ses_dm" })
    expect(store.getThread("ses_dm")).toEqual({ channel: "D123" })
  })

  test("channel engagement stores the mention thread as reply target", () => {
    const store = tempStore()
    store.setByKey("C1:channel", "ses_chan", "1699.0001")
    expect(store.getByKey("C1:channel")).toEqual({ sessionID: "ses_chan", replyTs: "1699.0001" })
    expect(store.getThread("ses_chan")).toEqual({ channel: "C1", replyTs: "1699.0001" })
  })

  test("removeByKey clears both directions", () => {
    const store = tempStore()
    store.setByKey("C1:1.0001", "ses_1", "1.0001")
    store.removeByKey("C1:1.0001")
    expect(store.getByKey("C1:1.0001")).toBeUndefined()
    expect(store.getThread("ses_1")).toBeUndefined()
  })

  test("migrates the old bare-string state format", () => {
    dir = mkdtempSync(join(tmpdir(), "opencode-slack-test-"))
    const path = join(dir, "state.json")
    writeFileSync(
      path,
      JSON.stringify({ threads: { "C1:1.0001": "ses_old" }, sessionThreads: { ses_old: "C1:1.0001" } }),
    )
    const store = new StateStore(path)
    expect(store.getByKey("C1:1.0001")).toEqual({ sessionID: "ses_old", replyTs: "1.0001" })
    expect(store.getThread("ses_old")).toEqual({ channel: "C1", replyTs: "1.0001" })
  })
})
