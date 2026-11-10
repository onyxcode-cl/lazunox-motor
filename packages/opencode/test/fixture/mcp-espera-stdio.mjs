// Lazunox (Q1.1): MCP stdio mínimo para probar el plazo de espera. DELAY = ms que tarda en responder a initialize; NAME = nombre; FAIL=1: sale con error.
import { createInterface } from 'node:readline'
const D = Number(process.env.DELAY ?? 0), N = process.env.NAME ?? 'x'
if (process.env.FAIL) { setTimeout(() => process.exit(1), D); }
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l)
  if (m.method === 'initialize') setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: N, version: '1' } } }), D)
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'eco_' + N, description: 'eco ' + N, inputSchema: { type: 'object', properties: {} } }] } })
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok' }] } })
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} })
})
