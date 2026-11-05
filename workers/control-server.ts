/**
 * Container control server. The Durable Object talks to this on :4001 so the
 * container never needs S3/R2 credentials: the DO streams checkpoints to R2.
 *
 *   GET  /health      liveness
 *   GET  /status      { initialized, running }
 *   POST /start       start opencode serve and wait until it answers
 *   POST /restore     body = tar.gz, replaces /workspace
 *   GET  /checkpoint  tar.gz stream of /workspace (deps excluded)
 */

import { spawn } from "bun"
import { existsSync, mkdirSync, rmSync } from "node:fs"

const WORKSPACE = process.env.WORKSPACE ?? "/workspace"
const STATE_DIR = process.env.XDG_DATA_HOME ?? `${WORKSPACE}/.state/data`
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? 4000)
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 4001)

let opencode: ReturnType<typeof spawn> | undefined

async function startOpencode(): Promise<void> {
  if (opencode) return
  opencode = spawn(["opencode", "serve", "--hostname", "0.0.0.0", "--port", String(OPENCODE_PORT)], {
    cwd: WORKSPACE,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  })
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${OPENCODE_PORT}/api/info`)
      if (res.ok) return
    } catch {
      /* not ready */
    }
    await Bun.sleep(200)
  }
  throw new Error("opencode did not become ready")
}

function initialized(): boolean {
  return existsSync(`${WORKSPACE}/.git`) || existsSync(`${WORKSPACE}/.stow`)
}

async function run(command: string[], options: { stdout?: "pipe" | "inherit" } = {}): Promise<void> {
  const proc = spawn(command, { stdout: options.stdout ?? "inherit", stderr: "inherit" })
  await proc.exited
}

Bun.serve({
  port: CONTROL_PORT,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === "/health") return Response.json({ ok: true })

    if (url.pathname === "/status") {
      return Response.json({ initialized: initialized(), running: Boolean(opencode) })
    }

    if (url.pathname === "/start") {
      await startOpencode()
      return Response.json({ ok: true })
    }

    if (url.pathname === "/restore" && request.method === "POST") {
      const tmp = "/tmp/restore.tar.gz"
      await Bun.write(tmp, new Response(request.body as ReadableStream))
      rmSync(WORKSPACE, { recursive: true, force: true })
      mkdirSync(WORKSPACE, { recursive: true })
      await run(["tar", "xzf", tmp, "-C", WORKSPACE])
      return Response.json({ ok: true })
    }

    if (url.pathname === "/checkpoint") {
      // Flush OpenCode's SQLite WAL so the checkpoint is consistent.
      try {
        await run(["sqlite3", `${STATE_DIR}/opencode.db`, "PRAGMA wal_checkpoint(TRUNCATE)"])
      } catch {
        /* DB may not exist yet */
      }
      const tar = spawn(["tar", "czf", "-", "-C", WORKSPACE, "--exclude", "node_modules", "."], {
        stdout: "pipe",
        stderr: "inherit",
      })
      return new Response(tar.stdout as ReadableStream, {
        headers: { "content-type": "application/gzip" },
      })
    }

    return new Response("not found", { status: 404 })
  },
})

console.log(`control server listening on :${CONTROL_PORT}`)
