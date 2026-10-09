// Portal 促销跑马灯（2026-10-09）：第三层常驻轮播的源码契约。
// 前端对供应商中立的边界（neutral-contract）在此收口：'nous' 字面量只允许出现在
// 促销节（NOUS_PROVIDER_SLUG 常量及其引用），渲染组件吃提炼函数的产物、不认供应商名。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

function extract(name) {
  const match = pluginSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))
  assert.ok(match, `function ${name} must exist in plugin.js`)
  return match[0]
}
function constant(name, { multiline = false } = {}) {
  const pattern = multiline ? `^const ${name} = \\{[\\s\\S]*?\\n\\}` : `^const ${name} = [^\\n]*\\n`
  const match = pluginSource.match(new RegExp(pattern, 'm'))
  assert.ok(match, `constant ${name} must exist in plugin.js`)
  return match[0]
}

test('促销提炼函数存在且判据收紧：免费进、裸 -100% 不进、必须有原价', () => {
  const src = extract('extractSaleModels')
  assert.match(src, /free === true/, '免费模型走 free 标识通道')
  assert.match(src, /discount < 1/, 'discount<1 不算促销')
  assert.match(src, /!wasIn && !wasOut/, '没有原价的打折条目不进（裸 -100%）')
  assert.match(src, /pricing_pending|free_tier_pending/, '数据未就绪按无促销处理')
})

test('免费条目只带提供方+模型名+免费标识，不带价格；徽章数据随行提炼', () => {
  const sandbox = new Function([
    extract('extractSaleModels')
  ].join('\n\n') + '; return { extractSaleModels }')()
  const row = {
    models: ['meituan/LongCAT-2.5', 'nous/RLF-V3', 'xai/grok-beta'],
    featured_models: ['nous/RLF-V3'],
    capabilities: { 'nous/RLF-V3': { reasoning: true } },
    pricing: {
      'meituan/LongCAT-2.5': { free: true, input: '$0.00', output: '$0.00', discount_percent: 100 },
      'nous/RLF-V3': { input: '$0.10', output: '$0.50', discount_percent: 50, was_input: '$0.20', was_output: '$1.00' },
      'xai/grok-beta': { input: '$3.00', output: '$15.00', discount_percent: 100 }
    }
  }
  const items = sandbox.extractSaleModels(row)
  // RLF-V3 有原价 → 进；LongCAT free=true → 进；grok-beta 裸 -100% 无原价 → 不进。
  assert.deepEqual(items.map(i => i.id), ['nous/RLF-V3', 'meituan/LongCAT-2.5'], '打折在前、免费在后、裸-100%剔除')
  const freeItem = items.find(i => i.free === true)
  assert.equal(freeItem.provider, 'meituan')
  assert.equal(freeItem.label, 'LongCAT-2.5')
  assert.equal(freeItem.discount, null)
  assert.equal(freeItem.inPrice, '')
  assert.equal(freeItem.isNew, false)
  const paidItem = items.find(i => i.free !== true)
  assert.equal(paidItem.discount, 50)
  assert.equal(paidItem.wasIn, '$0.20')
  assert.equal(paidItem.wasOut, '$1.00')
  assert.equal(paidItem.isNew, true, 'featured_models 命中 → NEW 徽章')
  assert.equal(paidItem.reasoning, true, 'capabilities.reasoning → REASONING 徽章')
})

test('pending/脏数据一律返回空数组（不报错不渲染）', () => {
  const sandbox = new Function([
    extract('extractSaleModels')
  ].join('\n\n') + '; return { extractSaleModels }')()
  assert.deepEqual(sandbox.extractSaleModels(null), [])
  assert.deepEqual(sandbox.extractSaleModels({ pricing_pending: true, models: ['a/b'], pricing: {} }), [])
  assert.deepEqual(sandbox.extractSaleModels({ free_tier_pending: true }), [])
  assert.deepEqual(sandbox.extractSaleModels({ models: 'junk' }), [])
  assert.deepEqual(sandbox.extractSaleModels({ models: [null, 42, ''], pricing: {} }), [])
})

test('中立契约：nous 字面量只活在促销节常量与常量声明区', () => {
  // 常量声明本身 + 促销节内的引用合法；Section/Marquee 组件体与卡片内嵌开关列里不得再出现裸 'nous'。
  const sectionSrc = extract('SaleTickerSection')
  const marqueeSrc = extract('SaleMarquee')
  assert.doesNotMatch(sectionSrc, /'nous'/)
  assert.doesNotMatch(marqueeSrc, /'nous'/)
  // 2026-10-09 晚改版：开关嵌进平台卡片右侧，独立 SaleTickerSettingRow 组件已删除，
  // 中立契约改钉卡片内嵌开关列（saleSlugs 条件块 → Sale ticker aria-label）。
  const cardSwitchSrc = pluginSource.match(/saleSlugs\[provider\.id\][\s\S]*?Sale ticker for \$\{provider\.label\}`/)?.[0] ?? ''
  assert.ok(cardSwitchSrc, 'in-card sale switch block must exist')
  assert.doesNotMatch(cardSwitchSrc, /'nous'/, '卡片内嵌开关供应商无关')
  assert.match(pluginSource, /const NOUS_PROVIDER_SLUG = 'nous'/)
})

test('useQuery 不得进入 Body/Panel 函数体（测试沙箱裸调这两个函数）', () => {
  const bodySrc = pluginSource.match(/function SubscriptionMeterBody\([\s\S]*?\n\}/)?.[0] ?? ''
  const panelSrc = pluginSource.match(/function ProviderSettingsPanel\([\s\S]*?\n\}/)?.[0] ?? ''
  const panelBodySrc = extract('ProviderSettingsPanelBody')
  assert.ok(bodySrc, 'SubscriptionMeterBody must exist')
  assert.ok(panelSrc, 'ProviderSettingsPanel must exist')
  assert.doesNotMatch(bodySrc, /\buseQuery\(/)
  assert.doesNotMatch(panelSrc, /\buseQuery\(/)
  assert.doesNotMatch(panelBodySrc, /\buseQuery\(/)
  // 促销组件必须定义在 SubscriptionMeterBody 之前（reset-column-fit 截取 Body→Page 区段断言无 hooks）。
  const bodyAt = pluginSource.indexOf('function SubscriptionMeterBody(')
  const tickerAt = pluginSource.indexOf('function SaleTickerSection(')
  assert.ok(tickerAt > 0 && tickerAt < bodyAt, 'SaleTickerSection must be defined before SubscriptionMeterBody')
})

// 2026-10-09 晚改版结构契约：开关从独立 SaleTickerSettingsEntry 区块嵌进各平台卡片。
// 三段式：ProviderSettingsPanel=沙箱安全桥（无 hook，裸调不炸）→
// ProviderSettingsPanelWithSaleTicker=真实 App 包装（三个 hook 全住这）→
// ProviderSettingsPanelBody=原全部逻辑（开关列新增第三枚小开关，saleSlugs 条件渲染）。
test('开关嵌入平台卡片：Panel=沙箱桥、WithSaleTicker=hook 宿主、Body=原逻辑+内嵌开关', () => {
  const panelSrc = extract('ProviderSettingsPanel')
  const wrapperSrc = extract('ProviderSettingsPanelWithSaleTicker')
  const bodySrc = extract('ProviderSettingsPanelBody')
  // 桥：host.profile.get 不可用时直接调 Body（沙箱裸调安全），否则包一层 WithSaleTicker。
  assert.match(panelSrc, /typeof host\?\.state\?\.profile\?\.get !== 'function'/, '桥接判断必须存在')
  assert.match(panelSrc, /ProviderSettingsPanelBody\(props\)/, '无 hook 回退直调 Body')
  assert.match(panelSrc, /jsx\(ProviderSettingsPanelWithSaleTicker, props\)/, '真实 App 走包装')
  // 桥体里不得出现任何 hook 调用——这是沙箱裸调安全的关键约束，钉死。
  assert.doesNotMatch(panelSrc, /\buseValue\(/)
  assert.doesNotMatch(panelSrc, /\buseSaleTickerEnabledMap\(/)
  assert.doesNotMatch(panelSrc, /\buseProviderSaleCatalog\(/)
  // 包装层：三个 hook 全住这里。
  assert.match(wrapperSrc, /useValue\(host\.state\.profile\)/)
  assert.match(wrapperSrc, /useSaleTickerEnabledMap\(\)/)
  assert.match(wrapperSrc, /useProviderSaleCatalog\(/)
  assert.match(wrapperSrc, /ProviderSettingsPanelBody\(\{ \.\.\.props, saleTickerMap, setSaleTickerPlatform, saleSlugs \}\)/, 'hook 产物注入 Body')
  // Body：接收注入的映射与目录（默认空值可裸跑），卡片开关列含第三枚 Sale ticker 小开关。
  assert.match(bodySrc, /saleTickerMap = \{\}/)
  assert.match(bodySrc, /saleSlugs = \{\}/)
  assert.match(bodySrc, /saleSlugs\[provider\.id\]/, '卡片内嵌开关按平台目录条件渲染')
  assert.match(bodySrc, /`Sale ticker for \$\{provider\.label\}`/, '内嵌开关 aria-label')
  // 旧独立区块的组件与挂载已随改版删除。
  assert.doesNotMatch(pluginSource, /function SaleTickerSettingsEntry\(/)
  assert.doesNotMatch(pluginSource, /function SaleTickerSettingRow\(/)
  assert.doesNotMatch(pluginSource, /jsx\(SaleTickerSettingsEntry/)
})

test('轮播挂载点：children 固定末位、key 固定、balance lane 之后', () => {
  assert.match(pluginSource, /jsx\(SaleTickerSection, \{ key: 'sale-ticker', profile: activeProfile \}\)/)
  const balanceAt = pluginSource.indexOf("'data-zone': 'balance'")
  const tickerAt = pluginSource.indexOf("jsx(SaleTickerSection, { key: 'sale-ticker'")
  assert.ok(balanceAt > 0 && tickerAt > balanceAt, 'ticker must render after the balance lane')
})

test('开关通道：按平台映射存取 + 旧单值迁移 + 双事件同步', () => {
  assert.match(pluginSource, /subscription-meter:sale-ticker/)
  const readSrc = extract('readSaleTickerEnabledMap')
  const hookSrc = extract('useSaleTickerEnabledMap')
  // 旧单值自动迁移（2026-10-09 前存过 'true'/'false' 的机器平滑升级）。
  assert.match(readSrc, /'true' \|\| raw === 'false'/)
  assert.match(readSrc, /JSON\.parse/)
  assert.match(hookSrc, /subscription-meter:settings-changed/)
  assert.match(hookSrc, /addEventListener\('storage'/)
  assert.match(hookSrc, /removeEventListener\('storage'/)
  assert.match(hookSrc, /notifySettingsChanged\(\)/)
  // 开关本体已嵌进平台卡片右侧开关列（2026-10-09 晚改版）：
  // saleSlugs[provider.id] 有促销目录才渲染第三枚 Sale ticker 小开关。
  assert.match(pluginSource, /saleSlugs\[provider\.id\]/)
  assert.match(pluginSource, /`Sale ticker for \$\{provider\.label\}`/)
  // 旧独立区块的挂载与组件已随改版删除。
  assert.doesNotMatch(pluginSource, /jsx\(SaleTickerSettingsEntry/)
  assert.doesNotMatch(pluginSource, /function SaleTickerSettingsEntry\(/)
  assert.doesNotMatch(pluginSource, /function SaleTickerSettingRow\(/)
})

test('hasPricingSignal：有价格或在途才算；纯订阅平台不给开关行', () => {
  const sandbox = new Function([
    extract('hasPricingSignal')
  ].join('\n\n') + '; return { hasPricingSignal }')()
  assert.equal(sandbox.hasPricingSignal(null), false)
  assert.equal(sandbox.hasPricingSignal({}), false)
  assert.equal(sandbox.hasPricingSignal({ pricing: { 'a/b': { input: '$1' } } }), true)
  assert.equal(sandbox.hasPricingSignal({ pricing_pending: true }), true)
  assert.equal(sandbox.hasPricingSignal({ free_tier_pending: true }), true)
  assert.equal(sandbox.hasPricingSignal({ pricing: {} }), false)
  assert.equal(sandbox.hasPricingSignal({ models: ['a/b'] }), false)
})

test('跑马灯聚合多平台条目并带 platform 标签（渲染供应商无关）', () => {
  const sandbox = new Function([
    extract('extractSaleModels')
  ].join('\n\n') + '; return { extractSaleModels }')()
  const nousRow = {
    slug: 'nous',
    models: ['nous/RLF-V3'],
    pricing: { 'nous/RLF-V3': { input: '$0.10', output: '$0.50', discount_percent: 50, was_input: '$0.20', was_output: '$1.00' } }
  }
  const orRow = {
    slug: 'openrouter',
    models: ['vendor/cheap-model'],
    pricing: { 'vendor/cheap-model': { input: '$0.05', output: '$0.10', discount_percent: 80, was_input: '$0.25', was_output: '$0.50' } }
  }
  const items = [
    ...sandbox.extractSaleModels(orRow, 'openrouter'),
    ...sandbox.extractSaleModels(nousRow, 'nous')
  ]
  // 全局聚合后折扣大的在前（OpenRouter -80% 压过 Nous -50%）——这正是多平台合并的意义。
  assert.deepEqual(items.map(i => i.platform), ['openrouter', 'nous'])
  assert.deepEqual(items.map(i => i.discount), [80, 50])
})

test('跑马灯：rAF 驱动、悬停暂停、cleanup 全清', () => {
  const src = extract('SaleMarquee')
  assert.match(src, /requestAnimationFrame/)
  assert.match(src, /cancelAnimationFrame/)
  assert.match(src, /onMouseEnter/, '悬停暂停')
  assert.match(src, /onMouseLeave/, '移开继续')
  assert.match(src, /pausedRef/, '暂停走 ref，不销毁循环')
  assert.match(src, /ResizeObserver/)
  assert.match(src, /disconnect\(\)/)
  // 2026-10-09 手动滑动：滚轮擦洗挂原生非 passive 监听（preventDefault 拦面板竖滚）。
  // 源码用可选链调用 el?.addEventListener?.(...)，正则兼容 ?. 形态。
  assert.match(src, /addEventListener(\?\.)?\('wheel'/)
  assert.match(src, /\{ passive: false \}/)
  assert.match(src, /removeEventListener(\?\.)?\('wheel'/)
  // 拖拽走 pointer events + dragRef 记录起点 + 取模归一。
  assert.match(src, /onPointerDown/)
  assert.match(src, /onPointerUp/)
  assert.match(src, /onPointerCancel/)
  assert.match(src, /dragRef/)
  assert.match(src, /setPointerCapture/)
  assert.match(src, /normalizeMarqueeOffset/)
  // 容器样式：grab 光标、禁文本选择、竖向平移留给页面。
  assert.match(src, /cursor: 'grab'/)
  assert.match(src, /userSelect: 'none'/)
  assert.match(src, /touchAction: 'pan-y'/)
})

// 2026-10-09 样式改版（Neal 行情条参考图）：全名等宽粗体、NEW/REASONING/FREE/折扣
// 胶囊、价格 `$in / $out` 一组 + 原价整组划线。排版函数只吃提炼产物，不认供应商名。
test('条目排版：全名粗体 + 徽章胶囊 + 价格组整组划线', () => {
  const itemSrc = extract('saleItemNode')
  const badgeSrc = extract('saleBadge')
  assert.match(itemSrc, /`\$\{item\.provider\}\/\$\{item\.label\}`|item\.provider \? `/, '全名 provider/model')
  assert.match(itemSrc, /font-mono/, '等宽字体')
  assert.match(itemSrc, /font-semibold/, '模型名粗体')
  assert.match(badgeSrc, /textTransform: 'uppercase'/, '徽章全大写')
  assert.match(badgeSrc, /borderRadius/, '胶囊圆角')
  assert.match(itemSrc, /color-mix\(in srgb, var\(--ui-orange\)/, '折扣胶囊=暗橙底（主题变量调出）')
  assert.match(itemSrc, /' \/ '/, '价格 $in / $out 一组')
  assert.match(itemSrc, /<s|'s',/, '原价整组划线')
  assert.match(itemSrc, /item\.isNew/, 'NEW 徽章')
  assert.match(itemSrc, /item\.reasoning/, 'REASONING 徽章')
  assert.doesNotMatch(itemSrc, /'nous'/, '排版供应商无关')
})

// 跑马灯核心数学（2026-10-09）：回绕点=真实周期（B 组首条 offsetLeft−A 组首条
// offsetLeft），不是 scrollWidth/2——2n 条共 2n−1 个 gap，半宽多出 (n−1)g/2，会让
// 每次循环回绕肉眼可见地跳。这里从源码抽出 effect 函数体，用假 DOM + 假 rAF 逐帧复演。
test('跑马灯数学：量真实周期回绕、匀速推进、悬停冻结、恢复不跳变', () => {
  const marqueeSrc = extract('SaleMarquee')
  const effectBody = marqueeSrc.match(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[contentReady\]\)/)?.[1]
    ?.replace(/^\s*if \(!contentReady\) return undefined\n/m, '')
  assert.ok(effectBody, 'effect body must be extractable')

  // n=4 条，宽 200/300/260/340，gap 40 → 周期 = Σw + n·g = 1260（scrollWidth/2 会算错）。
  const WIDTHS = [200, 300, 260, 340]
  const GAP = 40
  const CYCLE = WIDTHS.reduce((s, w) => s + w, 0) + WIDTHS.length * GAP
  const makeTrack = () => {
    const kids = []
    for (let copy = 0; copy < 2; copy += 1) {
      let left = copy === 0 ? 0 : CYCLE
      for (const w of WIDTHS) {
        kids.push({ offsetLeft: left, style: {} })
        left += w + GAP
      }
    }
    return { children: kids, style: {} }
  }

  const speed = Number(constant('MARQUEE_SPEED_PX_PER_S').match(/=\s*(\d+)/)[1])
  let rafCb = null
  const requestAnimationFrame = fn => { rafCb = fn; return 1 }
  const cancelAnimationFrame = () => { rafCb = null }
  const halfWidthRef = { current: 0 }
  const offsetRef = { current: 0 }
  const pausedRef = { current: false }
  const track = makeTrack()
  const trackRef = { current: track }
  // 2026-10-09 手动滑动改版：effect 体引用 containerRef（挂非 passive wheel 监听）
  // 与 normalizeMarqueeOffset（自动推进取模），沙箱注入相应假对象/抽取函数。
  const containerRef = {
    current: {
      addEventListener: () => {},
      removeEventListener: () => {},
      setPointerCapture: () => {},
      releasePointerCapture: () => {}
    }
  }
  new Function(
    'trackRef', 'halfWidthRef', 'offsetRef', 'pausedRef', 'MARQUEE_SPEED_PX_PER_S',
    'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver',
    'containerRef', 'normalizeMarqueeOffset',
    effectBody
  )(
    trackRef, halfWidthRef, offsetRef, pausedRef, speed,
    requestAnimationFrame, cancelAnimationFrame, undefined,
    containerRef, new Function(
      [extract('normalizeMarqueeOffset')].join('\n\n') + '; return { normalizeMarqueeOffset }'
    )().normalizeMarqueeOffset
  )
  assert.ok(rafCb, '循环已排程')
  assert.equal(halfWidthRef.current, 0, '首帧前未量测')

  let ts = 1000
  const frame = () => { ts += 16; const cb = rafCb; rafCb = null; cb(ts) }

  frame()
  assert.equal(halfWidthRef.current, CYCLE, '量到的是真实周期 Σw+n·g，不是 scrollWidth/2')
  assert.equal(offsetRef.current, 0, '首帧零位移（last ?? ts 防挂载跳变），只量测')
  const pxPerFrame = speed * 16 / 1000
  frame()
  assert.ok(Math.abs(offsetRef.current - pxPerFrame) < 1e-9, '第二帧起按 16ms 匀速推进')

  // 长跑：跨过至少一次回绕，位移始终落在 [0, 周期) 内。
  for (let i = 0; i < 3000; i += 1) frame()
  assert.ok(offsetRef.current >= 0 && offsetRef.current < CYCLE, '回绕后仍在周期内')
  assert.match(track.style.transform, /^translateX\(-\d+(\.\d+)?px\)$/)

  // 悬停：时间照走、位移与 transform 完全冻结。
  const frozenAt = offsetRef.current
  const frozenTransform = track.style.transform
  pausedRef.current = true
  for (let i = 0; i < 30; i += 1) frame()
  assert.equal(offsetRef.current, frozenAt, '悬停期间不推进')
  assert.equal(track.style.transform, frozenTransform)

  // 恢复：从冻结点续走，不归零不跳变。
  pausedRef.current = false
  frame()
  assert.ok(Math.abs(offsetRef.current - (frozenAt + pxPerFrame)) < 1e-6, '恢复从冻结点继续')
})

// normalizeMarqueeOffset（2026-10-09）：自动滚动与手动擦洗共用的取模归一。
// 正向过界回绕、负值（拖拽越过 0 点）折到周期尾段、整周期归零、cycle<=0 原样返回。
test('normalizeMarqueeOffset：周期内回绕、负值折返、非正周期恒等', () => {
  const sandbox = new Function([
    extract('normalizeMarqueeOffset')
  ].join('\n\n') + '; return { normalizeMarqueeOffset }')()
  const { normalizeMarqueeOffset } = sandbox
  assert.equal(normalizeMarqueeOffset(1300, 1260), 40, '正向过界回绕')
  assert.equal(normalizeMarqueeOffset(-40, 1260), 1220, '负值折到周期尾段')
  assert.equal(normalizeMarqueeOffset(2520, 1260), 0, '整周期归零')
  assert.equal(normalizeMarqueeOffset(0, 1260), 0, '零点保持')
  assert.equal(normalizeMarqueeOffset(123, 0), 123, 'cycle=0 恒等')
  assert.equal(normalizeMarqueeOffset(-77, -5), -77, '负 cycle 恒等')
})
