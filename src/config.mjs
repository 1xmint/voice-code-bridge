// Config and on-disk paths for voice-code-bridge.
// Everything sensitive (secret, logs, tasks) lives outside the repo, under
// VCB_HOME or ~/.voice-code-bridge, never inside the git checkout.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export function getHome() {
  return process.env.VCB_HOME || path.join(os.homedir(), '.voice-code-bridge')
}

export function getPort() {
  const p = Number(process.env.VCB_PORT)
  return Number.isFinite(p) && p > 0 ? p : 8790
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function generateSecret() {
  return crypto.randomBytes(32).toString('base64url')
}

// Loads config.json, creating it (and the home directory) with a fresh
// random secret on first run. Never logs the secret.
export function loadConfig(home = getHome()) {
  ensureDir(home)
  const configPath = path.join(home, 'config.json')
  let config
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } else {
    config = { secret: generateSecret(), created_at: new Date().toISOString() }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
  }
  return { ...config, configPath }
}

export function getPaths(home = getHome()) {
  ensureDir(home)
  return {
    home,
    configPath: path.join(home, 'config.json'),
    logPath: path.join(home, 'bridge.log'),
    tasksJsonlPath: path.join(home, 'tasks.jsonl'),
  }
}
