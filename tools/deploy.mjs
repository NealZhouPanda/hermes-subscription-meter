#!/usr/bin/env node
// 部署守卫（2026-09-26 插件「损坏」事故后加的）：
//   语法检查 → 跑全部前端测试 → 备份上一版为 .last-good → **原子替换**运行态 →
//   收据（sha256）→ 哨兵：扫 App 日志有没有新的 error-boundary / React #310 行，
//   命中就自动回滚，并把命中行打出来。
//
// 为什么要有这个脚本：
//   1) 运行态目录被 App 监听，**任何存盘都会被当成活代码执行**——多步 patch 的中间态
//      会被热重载跑（技能里 2026-09-22、2026-09-26 各踩过一次）。这里写临时文件再
//      rename，替换是单次原子动作，中间态永远不会出现在被监听的文件上。
//   2) `node --check` 与单元测试拦不住 React 运行时错误（hook 顺序等）。所以部署后
//      看一次真实日志，坏了立刻回滚，不等人报「插件损坏」。
//
// 用法：
//   node tools/deploy.mjs [--runtime <plugin.js 路径>] [--log <desktop.log 路径>]
//                         [--settle <秒>] [--skip-tests] [--no-sentinel]
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(REPO, 'desktop', 'plugin.js')

function parseArgs(argv) {
  const args = { runtime: null, log: null, settle: 6, tests: true, sentinel: true }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--runtime') args.runtime = resolve(argv[++i])
    else if (flag === '--log') args.log = resolve(argv[++i])
    else if (flag === '--settle') args.settle = Number(argv[++i])
    else if (flag === '--skip-tests') args.tests = false
    else if (flag === '--no-sentinel') args.sentinel = false
    else throw new Error(`unknown flag: ${flag}`)
  }
  if (!args.runtime) {
    const home = process.env.HERMES_HOME || join(process.env.HOME || '', '.hermes')
    args.runtime = join(home, 'desktop-plugins', 'subscription-meter', 'plugin.js')
  }
  if (!args.log) {
    const home = process.env.HERMES_HOME || join(process.env.HOME || '', '.hermes')
    args.log = join(home, 'logs', 'desktop.log')
  }
  return args
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const time = () => new Date().toISOString()
const say = message => process.stdout.write(`${message}\n`)

// 原子写：先写同目录临时文件，再 rename 覆盖——被监听的目录永远看不到半成品。
function writeAtomic(target, content) {
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.tmp-${process.pid}`
  writeFileSync(temp, content, { mode: 0o644 })
  renameSync(temp, target)
}

function copyAtomic(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  const temp = `${to}.tmp-${process.pid}`
  copyFileSync(from, temp)
  renameSync(temp, to)
}

function syntaxCheck() {
  const run = spawnSync(process.execPath, ['--check', SOURCE], { encoding: 'utf8' })
  if (run.status !== 0) {
    say(`[deploy] FAILED syntax check\n${run.stderr || ''}`)
    process.exit(1)
  }
  say('[deploy] syntax ok')
}

function runFrontendTests() {
  const files = readdirSync(join(REPO, 'tests')).filter(name => name.endsWith('.test.mjs')).map(name => join('tests', name))
  const run = spawnSync(process.execPath, ['--test', ...files], { cwd: REPO, encoding: 'utf8' })
  const output = `${run.stdout || ''}${run.stderr || ''}`
  const summary = output.split('\n').filter(line => /^# (tests|pass|fail)/.test(line)).join(' | ')
  if (run.status !== 0) {
    say(`[deploy] FAILED tests — nothing was deployed\n${output.split('\n').filter(l => /^not ok|^# (tests|pass|fail)/.test(l)).join('\n')}`)
    process.exit(1)
  }
  say(`[deploy] tests ok — ${summary}`)
}

// 只看部署之后、且点名本插件的日志行：别的插件或别的表面炸了不该回滚这一版。
function freshFailures(logPath, sinceMs) {
  if (!existsSync(logPath)) return []
  const lines = readFileSync(logPath, 'utf8').split('\n').slice(-4000)
  return lines.filter(line => {
    if (!/error-boundary|React error #310|runtime load failed/i.test(line)) return false
    if (!/subscription-meter/i.test(line)) return false
    const stamp = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/.exec(line)
    if (!stamp) return false
    return Date.parse(stamp[1]) >= sinceMs - 2000
  })
}

function writeReceipt(runtimePath, receipt) {
  writeAtomic(join(dirname(runtimePath), 'deploy-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}

const args = parseArgs(process.argv.slice(2))
syntaxCheck()
if (args.tests) runFrontendTests()

const previous = existsSync(args.runtime) ? sha256(args.runtime) : null
const lastGood = `${args.runtime}.last-good`
if (previous) copyAtomic(args.runtime, lastGood)

const deployedAt = Date.now()
copyAtomic(SOURCE, args.runtime)
const receipt = {
  at: time(),
  source: 'desktop/plugin.js',
  sha256: sha256(args.runtime),
  previousSha256: previous,
  lastGood: previous ? lastGood : null,
  rolledBack: false
}
writeReceipt(args.runtime, receipt)
say(`[deploy] deployed ${receipt.sha256.slice(0, 12)} → ${args.runtime}${previous ? ` (kept ${previous.slice(0, 12)} as .last-good)` : ''}`)

if (!args.sentinel) process.exit(0)

say(`[deploy] watching ${args.log} for ${args.settle}s…`)
await new Promise(done => setTimeout(done, Math.max(0, args.settle) * 1000))
const failures = freshFailures(args.log, deployedAt)
if (!failures.length) {
  say('[deploy] no error-boundary / #310 from this plugin — keeping the new build')
  process.exit(0)
}

if (previous) copyAtomic(lastGood, args.runtime)
writeReceipt(args.runtime, { ...receipt, rolledBack: Boolean(previous), reason: 'error-boundary after deploy' })
say(`[deploy] ROLLED BACK — fresh failures in the app log${previous ? ` (runtime restored to ${previous.slice(0, 12)})` : ' (no previous build to restore)'}`)
failures.slice(-5).forEach(line => say(`    ${line.slice(0, 220)}`))
process.exit(1)
