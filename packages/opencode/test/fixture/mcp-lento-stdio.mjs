// Lazunox (Q1.1): MCP stdio mínimo y lento. DELAY = ms hasta responder initialize; LIST_DELAY = ms hasta responder tools/list;
// NAME = nombre; PIDDIR = carpeta donde escribe su PID (<NAME>.pid) para que la prueba compruebe si sigue vivo (portable, sin ps/pkill).
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const D = Number(process.env.DELAY ?? 0), L = Number(process.env.LIST_DELAY ?? 0), N = process.env.NAME ?? 'x'
if (process.env.PIDDIR) writeFileSync(join(process.env.PIDDIR, N + '.pid'), String(process.pid))
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l)
  if (m.method === 'initialize') setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: N, version: '1' } } }), D)
  else if (m.method === 'tools/list') setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'eco_' + N, description: 'eco', inputSchema: { type: 'object', properties: {} } }] } }), L)
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} })
})
setInterval(() => {}, 1 << 30)
