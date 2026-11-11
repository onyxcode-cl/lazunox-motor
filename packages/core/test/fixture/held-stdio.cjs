const { spawn } = require("node:child_process")
const fs = require("node:fs")

const mode = process.argv[2]
const child = spawn(
  process.execPath,
  [
    "-e",
    `
  process.on("SIGTERM", () => {})
  process.stdout.on("error", () => {})
  process.stderr.on("error", () => {})
  process.send("ready")
  ${
    process.argv[4] === "activity"
      ? `
  const fs = require("node:fs")
  setTimeout(() => {
    fs.writeSync(1, "late-out-1\\n")
    fs.writeSync(2, "late-err-1\\n")
  }, 180)
  setTimeout(() => {
    fs.writeSync(1, "late-out-2\\n")
    fs.writeSync(2, "late-err-2\\n")
  }, 360)
  `
      : ""
  }
  setTimeout(() => process.exit(0), 15000)
`,
  ],
  {
    detached: true,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  },
)
fs.writeFileSync(process.argv[3], String(child.pid))

child.once("message", () => {
  child.disconnect()
  child.unref()
  fs.writeSync(1, "foreground-out\n")
  fs.writeSync(2, "foreground-err\n")
  if (process.argv[4] === "backpressure") {
    fs.writeSync(1, "buffered-out\n".repeat(8192))
    fs.writeSync(2, "buffered-err\n".repeat(8192))
  }
  if (mode === "exit") process.exit(0)
  setTimeout(() => process.exit(0), 15000)
})
