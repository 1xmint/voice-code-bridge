// Points the voice-bridge MCP entry in ~/.claude.json at the doorway, or back
// at the plain bridge with --back. Backs the file up first. Takes effect at the
// next /mcp reconnect.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replaceAll('\\', '/')
const back = process.argv.includes('--back')
const target = `${repo}/bin/${back ? 'voice-code-bridge.mjs' : 'doorway.mjs'}`
const file = path.join(os.homedir(), '.claude.json')
const config = JSON.parse(fs.readFileSync(file, 'utf8'))
const entry = config.mcpServers?.['voice-bridge']
if (!entry) throw new Error('no voice-bridge entry in ~/.claude.json mcpServers')
fs.copyFileSync(file, `${file}.bak-${Date.now()}`)
entry.args = [target]
fs.writeFileSync(file, JSON.stringify(config, null, 2))
console.log(`voice-bridge now runs ${target}. Run /mcp to reconnect.`)
