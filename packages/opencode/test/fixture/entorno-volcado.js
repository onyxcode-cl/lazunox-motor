// Lazunox (motor-18, A): vuelca los NOMBRES (nunca los valores) del entorno propio, ordenados, como una línea «NOMBRES:<json>» por
// stdout; si LZX_OUT existe, también los escribe ahí (para hijos sin stdout útil: LSP, MCP, formateadores, pty).
const nombres = JSON.stringify(Object.keys(process.env).sort())
if (process.env.LZX_OUT) require("node:fs").writeFileSync(process.env.LZX_OUT, nombres)
console.log("NOMBRES:" + nombres)
