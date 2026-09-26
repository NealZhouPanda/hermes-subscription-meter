#!/usr/bin/env node
// 一键回滚：把 `.last-good`（上一次成功部署的运行态副本）原子换回运行态。
// 与 tools/deploy.mjs 配套；部署哨兵自动回滚走的是同一条路径。
//
// 用法：node tools/rollback.mjs [--runtime <plugin.js 路径>]
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flagIndex = argv.indexOf('--runtime')
const home = process.env.HERMES_HOME || join(process.env.HOME || '', '.hermes')
const runtime = flagIndex >= 0
  ? resolve(argv[flagIndex + 1])
  : join(home, 'desktop-plugins', 'subscription-meter', 'plugin.js')
const lastGood = `${runtime}.last-good`

if (!existsSync(lastGood)) {
  process.stderr.write(`[rollback] no ${lastGood} — nothing to roll back to\n`)
  process.exit(1)
}
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const before = existsSync(runtime) ? sha256(runtime) : null
mkdirSync(dirname(runtime), { recursive: true })
const temp = `${runtime}.tmp-${process.pid}`
copyFileSync(lastGood, temp)
renameSync(temp, runtime)
const after = sha256(runtime)
process.stdout.write(`[rollback] ${runtime}\n  was ${before ? before.slice(0, 12) : '(missing)'} → now ${after.slice(0, 12)} (from .last-good)\n`)
if (before !== null && before === after) process.stdout.write('  note: runtime was already at the .last-good build\n')
