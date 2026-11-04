import { describe, expect, test, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
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
    store.setByKey("C123:111.0001", "ses_abc")
    expect(store.getByKey("C123:111.0001")).toBe("ses_abc")
    expect(store.getThread("ses_abc")).toEqual({ channel: "C123", threadTs: "111.0001" })
  })

  test("persists to disk and reloads", () => {
    const store = tempStore()
    store.setByKey("C999:222.0002", "ses_xyz")
    const path = join(dir!, "state.json")
    const onDisk = JSON.parse(readFileSync(path, "utf8"))
    expect(onDisk.threads["C999:222.0002"]).toBe("ses_xyz")

    const reloaded = new StateStore(path)
    expect(reloaded.getByKey("C999:222.0002")).toBe("ses_xyz")
    expect(reloaded.getThread("ses_xyz")).toEqual({ channel: "C999", threadTs: "222.0002" })
  })

  test("supports the DM sentinel key", () => {
    const store = tempStore()
    store.setByKey("D123:dm", "ses_dm")
    expect(store.getByKey("D123:dm")).toBe("ses_dm")
    expect(store.getThread("ses_dm")).toEqual({ channel: "D123", threadTs: "dm" })
  })

  test("removeByKey clears both directions", () => {
    const store = tempStore()
    store.setByKey("C1:1.0001", "ses_1")
    store.removeByKey("C1:1.0001")
    expect(store.getByKey("C1:1.0001")).toBeUndefined()
    expect(store.getThread("ses_1")).toBeUndefined()
  })
})
