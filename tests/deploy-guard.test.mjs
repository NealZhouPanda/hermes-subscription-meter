// 部署守卫的测试（2026-09-26 插件「损坏」事故后加的）：
// 真跑 tools/deploy.mjs / tools/rollback.mjs，但用临时 runtime 与临时日志文件，
// 不碰真实运行态、不触发 App 的热重载。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(REPO, 'desktop', 'plugin.js')
const sourceText = readFileSync(SOURCE, 'utf8')

function makeCase(runtimeText) {
  const dir = mkdtempSync(join(tmpdir(), 'meter-deploy-'))
  const runtime = join(dir, 'plugin.js')
  const log = join(dir, 'desktop.log')
  if (runtimeText !== null) writeFileSync(runtime, runtimeText)
  writeFileSync(log, '')
  return { dir, runtime, log, receipt: join(dir, 'deploy-receipt.json') }
}

const runDeploy = (c, extra = []) => spawnSync(process.execPath, [
  join(REPO, 'tools', 'deploy.mjs'),
  '--runtime', c.runtime,
  '--log', c.log,
  '--skip-tests',
  '--settle', '0',
  ...extra
], { encoding: 'utf8' })

const runRollback = c => spawnSync(process.execPath, [
  join(REPO, 'tools', 'rollback.mjs'), '--runtime', c.runtime
], { encoding: 'utf8' })

// 日志行格式照抄 App：`[ISO(UTC)] [hermes] …`
const logLine = (plugin, secondsAgo = 0) =>
  `[${new Date(Date.now() - secondsAgo * 1000).toISOString()}] [hermes] [renderer console:main]`
  + ` [error-boundary:contrib:plugin:${plugin}:page] Error: Minified React error #310;\n`

test('部署：原子替换 + 留 .last-good + 写收据', () => {
  const c = makeCase('OLD_BUILD\n')
  const run = runDeploy(c)
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(readFileSync(c.runtime, 'utf8'), sourceText, '运行态应被换成本次源码')
  assert.equal(readFileSync(`${c.runtime}.last-good`, 'utf8'), 'OLD_BUILD\n', '上一版要留档')
  const receipt = JSON.parse(readFileSync(c.receipt, 'utf8'))
  assert.equal(receipt.rolledBack, false)
  assert.match(receipt.sha256, /^[0-9a-f]{64}$/)
  assert.notEqual(receipt.sha256, receipt.previousSha256, '收据要能区分新旧版本')
  assert.match(run.stdout, /deployed [0-9a-f]{12}/, '要打出部署收据')
  assert.equal(existsSync(`${c.runtime}.tmp-${process.pid}`), false, '不留临时文件')
})

test('首次部署（没有旧版本）：不凭空造 .last-good', () => {
  const c = makeCase(null)
  const run = runDeploy(c)
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(existsSync(`${c.runtime}.last-good`), false)
  assert.equal(JSON.parse(readFileSync(c.receipt, 'utf8')).previousSha256, null)
})

test('哨兵：日志里出现本插件的新 error-boundary → 自动回滚到上一版', () => {
  const c = makeCase('OLD_BUILD\n')
  writeFileSync(c.log, logLine('subscription-meter'))
  const run = runDeploy(c)
  assert.equal(run.status, 1, '有新鲜报错就必须以失败退出')
  assert.equal(readFileSync(c.runtime, 'utf8'), 'OLD_BUILD\n', '运行态要退回上一版')
  assert.match(run.stdout, /ROLLED BACK/)
  assert.match(run.stdout, /React error #310/, '要把命中的日志行打出来')
  const receipt = JSON.parse(readFileSync(c.receipt, 'utf8'))
  assert.equal(receipt.rolledBack, true)
  assert.match(receipt.reason, /error-boundary/)
})

test('哨兵只认本插件、只认部署之后的日志行', () => {
  // ① 别的插件炸了 → 不回滚
  const other = makeCase('OLD_BUILD\n')
  writeFileSync(other.log, logLine('hermes-achievements'))
  assert.equal(runDeploy(other).status, 0, '别的插件的报错不该回滚这一版')
  assert.equal(readFileSync(other.runtime, 'utf8'), sourceText)

  // ② 老日志（部署前就存在）→ 不回滚
  const stale = makeCase('OLD_BUILD\n')
  writeFileSync(stale.log, logLine('subscription-meter', 3600))
  assert.equal(runDeploy(stale).status, 0, '一小时前的报错不能触发回滚')
  assert.equal(readFileSync(stale.runtime, 'utf8'), sourceText)
})

test('回滚脚本：把 .last-good 换回运行态；没有档可回时明确失败', () => {
  const c = makeCase('OLD_BUILD\n')
  runDeploy(c)
  const run = runRollback(c)
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(readFileSync(c.runtime, 'utf8'), 'OLD_BUILD\n')
  assert.match(run.stdout, /was [0-9a-f]{12} → now [0-9a-f]{12}/)

  const bare = makeCase('ONLY_BUILD\n')
  const failed = runRollback(bare)
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /nothing to roll back to/)
  assert.equal(readFileSync(bare.runtime, 'utf8'), 'ONLY_BUILD\n', '失败时不许动运行态')
})
