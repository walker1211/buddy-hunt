#!/usr/bin/env node
// buddy-reroll.js
// Buddy reroll script — supports both Node.js and Bun
// Bun.hash 结果与 Claude Code 对齐；Node.js (FNV-1a) 结果不对齐。
//
// Usage:
//   bun  buddy-reroll.js [options]    # Bun.hash 模式（搜索模式预留并行 workers；结果与 Claude Code 对齐）
//   node buddy-reroll.js [options]    # Node.js 模式（单进程 FNV-1a，不对齐）
//
// Options:
//   --species <name>       Target species (duck, cat, dragon, ...)
//   --rarity <name>        Minimum rarity (common, uncommon, rare, epic, legendary)
//   --eye <char>           Target eye style (· ✦ × ◉ @ °)
//   --hat <name>           Target hat (none, crown, tophat, propeller, halo, wizard, beanie, tinyduck)
//   --shiny                Require shiny
//   --min-stats [value]    Require ALL stats >= value (default: 90) (legacy compatibility)
//   --stat <expr>          Add a stat comparison (STAT>=value, STAT<=value, STAT=value)
//   --min-stat <number>    Require all stats >= value (1-100)
//   --max-stat <number>    Require all stats <= value (1-100)
//   --min-total <number>   Require total stats >= value (5-500)
//   --max-total <number>   Require total stats <= value (5-500)
//   --min-avg <number>     Require average stat >= value (1-100)
//   --max-avg <number>     Require average stat <= value (1-100)
//   --max <number>         Max iterations per worker in Bun search, or per process in Node search (default: 500000000)
//   --count <number>       Number of results to find (default: 3)
//   --workers <n>          Bun search worker count (search mode only; default: auto by CPU)
//   --check <uid>          Check what buddy a specific userID produces (exclusive with search filters)
//
// Examples:
//   bun buddy-reroll.js --species duck --rarity legendary --shiny
//   bun buddy-reroll.js --species dragon --min-stats 80
//   bun buddy-reroll.js --workers 8 --count 5
//   bun buddy-reroll.js --species mushroom --rarity legendary --shiny --count 1 --workers 8
//   bun buddy-reroll.js --check f17c2742a00b2345c22fddc830959a6847ceb561fa06adb26b74b1a91ac657bc

const crypto = require('crypto')
const os = require('node:os')

// --- Constants (must match Claude Code source) ---
const SALT = 'friend-2026-401'
const SPECIES = ['duck', 'goose', 'blob', 'cat', 'dragon', 'octopus', 'owl', 'penguin', 'turtle', 'snail', 'ghost', 'axolotl', 'capybara', 'cactus', 'robot', 'rabbit', 'mushroom', 'chonk']
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary']
const RARITY_WEIGHTS = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 }
const RARITY_RANK = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 }
const EYES = ['·', '✦', '×', '◉', '@', '°']
const HATS = ['none', 'crown', 'tophat', 'propeller', 'halo', 'wizard', 'beanie', 'tinyduck']
const STAT_NAMES = ['DEBUGGING', 'PATIENCE', 'CHAOS', 'WISDOM', 'SNARK']
const RARITY_FLOOR = { common: 5, uncommon: 15, rare: 25, epic: 35, legendary: 50 }
const DEFAULT_MAX_ITERATIONS = 500_000_000
const ATTEMPT_REPORT_INTERVAL = 100_000
const ATTEMPT_REPORT_INTERVAL_MS = 1_000
const WORKER_YIELD_INTERVAL = 1_000
const PROGRESS_INTERVAL_MS = 60_000

function isBunRuntime() {
  return typeof Bun !== 'undefined'
}

function isBunWorkerRuntime() {
  return isBunRuntime() && Bun.isMainThread === false
}

// --- Hash functions ---
function hashFNV1a(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function hashBun(s) {
  return Number(BigInt(Bun.hash(s)) & 0xffffffffn)
}

// --- PRNG (Mulberry32 — same as Claude Code) ---
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)]
}

function rollRarity(rng) {
  let roll = rng() * 100
  for (const r of RARITIES) {
    roll -= RARITY_WEIGHTS[r]
    if (roll < 0) return r
  }
  return 'common'
}

function rollStats(rng, rarity) {
  const floor = RARITY_FLOOR[rarity]
  const peak = pick(rng, STAT_NAMES)
  let dump = pick(rng, STAT_NAMES)
  while (dump === peak) dump = pick(rng, STAT_NAMES)
  const stats = {}
  for (const name of STAT_NAMES) {
    if (name === peak) stats[name] = Math.min(100, floor + 50 + Math.floor(rng() * 30))
    else if (name === dump) stats[name] = Math.max(1, floor - 10 + Math.floor(rng() * 15))
    else stats[name] = floor + Math.floor(rng() * 40)
  }
  return stats
}

function createRoller(hashFn) {
  return function rollFull(uid) {
    const rng = mulberry32(hashFn(uid + SALT))
    const rarity = rollRarity(rng)
    const species = pick(rng, SPECIES)
    const eye = pick(rng, EYES)
    const hat = rarity === 'common' ? 'none' : pick(rng, HATS)
    const shiny = rng() < 0.01
    const stats = rollStats(rng, rarity)
    return { rarity, species, eye, hat, shiny, stats }
  }
}

// --- CLI helpers ---
function fail(message) {
  console.error(message)
  process.exit(1)
}

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)

function parseStrictInt(token, label, { min, max } = {}) {
  if (!/^[0-9]+$/.test(token)) {
    fail(`${label} 必须是十进制整数（收到: ${token}）`)
  }
  const bigValue = BigInt(token)
  if (bigValue > MAX_SAFE_INTEGER_BIGINT) {
    fail(`${label} 超出安全整数范围（<= ${Number.MAX_SAFE_INTEGER}）`)
  }
  const value = Number(bigValue)
  if (min !== undefined && value < min) fail(`${label} 必须 >= ${min}`)
  if (max !== undefined && value > max) fail(`${label} 必须 <= ${max}`)
  return value
}

function readArgValue(args, index, flag, { allowLeadingDash = false } = {}) {
  const next = args[index + 1]
  if (next === undefined || (!allowLeadingDash && next.startsWith('--'))) {
    fail(`${flag} 需要一个值`)
  }
  if (next === '') {
    fail(`${flag} 需要一个非空值`)
  }
  return next
}

function parseStatFilter(expr) {
  const trimmed = expr.trim()
  const match = /^([A-Z]+)\s*(>=|<=|=)\s*(\d+)$/.exec(trimmed)
  if (!match) fail(`无效的 --stat 表达式: ${expr}`)
  const name = match[1]
  if (!STAT_NAMES.includes(name)) {
    fail(`未知 stat: ${name}\n可选 stat: ${STAT_NAMES.join(', ')}`)
  }
  const value = parseStrictInt(match[3], '--stat 值', { min: 1, max: 100 })
  return { name, op: match[2], value, expr: `${name}${match[2]}${value}` }
}

function getDefaultWorkerCount() {
  let cpuCount = 1
  if (typeof os.availableParallelism === 'function') {
    cpuCount = os.availableParallelism()
  } else if (Array.isArray(os.cpus()) && os.cpus().length > 0) {
    cpuCount = os.cpus().length
  }
  return cpuCount > 1 ? cpuCount - 1 : 1
}

// --- Parse CLI args ---
function parseArgs() {
  const args = process.argv.slice(2)
  const isBun = isBunRuntime()
  const opts = { max: DEFAULT_MAX_ITERATIONS, count: 3, statFilters: [], workersAuto: true, workersExplicit: false }
  let minStatFromMinStats
  let minStatFlagValue
  let maxStatFlagValue
  let minTotal
  let maxTotal
  let minAvg
  let maxAvg
  let workerCount
  let workerCountExplicit = false
  let hasSearchFilters = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--species':
        opts.species = readArgValue(args, i, '--species')
        hasSearchFilters = true
        i++
        break
      case '--rarity':
        opts.rarity = readArgValue(args, i, '--rarity')
        hasSearchFilters = true
        i++
        break
      case '--eye':
        opts.eye = readArgValue(args, i, '--eye')
        hasSearchFilters = true
        i++
        break
      case '--hat':
        opts.hat = readArgValue(args, i, '--hat')
        hasSearchFilters = true
        i++
        break
      case '--shiny':
        opts.shiny = true
        hasSearchFilters = true
        break
      case '--min-stats': {
        const next = args[i + 1]
        let value
        if (next === undefined) {
          value = 90
        } else if (next === '') {
          fail('--min-stats 需要一个非空值')
        } else if (next.startsWith('--')) {
          value = 90
        } else {
          value = parseStrictInt(next, '--min-stats', { min: 1, max: 100 })
          i++
        }
        minStatFromMinStats = value
        hasSearchFilters = true
        break
      }
      case '--stat': {
        const expr = readArgValue(args, i, '--stat')
        opts.statFilters.push(parseStatFilter(expr))
        hasSearchFilters = true
        i++
        break
      }
      case '--min-total':
        minTotal = parseStrictInt(readArgValue(args, i, '--min-total'), '--min-total', { min: 5, max: 500 })
        hasSearchFilters = true
        i++
        break
      case '--max-total':
        maxTotal = parseStrictInt(readArgValue(args, i, '--max-total'), '--max-total', { min: 5, max: 500 })
        hasSearchFilters = true
        i++
        break
      case '--min-avg':
        minAvg = parseStrictInt(readArgValue(args, i, '--min-avg'), '--min-avg', { min: 1, max: 100 })
        hasSearchFilters = true
        i++
        break
      case '--max-avg':
        maxAvg = parseStrictInt(readArgValue(args, i, '--max-avg'), '--max-avg', { min: 1, max: 100 })
        hasSearchFilters = true
        i++
        break
      case '--min-stat':
        minStatFlagValue = parseStrictInt(readArgValue(args, i, '--min-stat'), '--min-stat', { min: 1, max: 100 })
        hasSearchFilters = true
        i++
        break
      case '--max-stat':
        maxStatFlagValue = parseStrictInt(readArgValue(args, i, '--max-stat'), '--max-stat', { min: 1, max: 100 })
        hasSearchFilters = true
        i++
        break
      case '--max':
        opts.max = parseStrictInt(readArgValue(args, i, '--max'), '--max', { min: 1 })
        hasSearchFilters = true
        i++
        break
      case '--count':
        opts.count = parseStrictInt(readArgValue(args, i, '--count'), '--count', { min: 1 })
        hasSearchFilters = true
        i++
        break
      case '--workers':
        workerCount = parseStrictInt(readArgValue(args, i, '--workers'), '--workers', { min: 1 })
        workerCountExplicit = true
        opts.workersExplicit = true
        opts.workersAuto = false
        i++
        break
      case '--check':
        opts.check = readArgValue(args, i, '--check', { allowLeadingDash: true })
        i++
        break
      case '--help':
      case '-h':
        console.log(`Usage:
  bun  buddy-reroll.js [options]    # Bun.hash 模式（搜索模式预留并行 workers；结果与 Claude Code 对齐）
  node buddy-reroll.js [options]    # Node.js 模式（单进程 FNV-1a，不对齐）

Options:
  --species <name>       ${SPECIES.join(', ')}
  --rarity <name>        ${RARITIES.join(', ')}
  --eye <char>           ${EYES.join(' ')}
  --hat <name>           ${HATS.join(' ')}
  --shiny                Require shiny
  --min-stats [value]    Require ALL stats >= value (default: 90) (legacy compatibility)
  --stat <expr>          解析 STAT<=value 类表达式（只支持 >= <= =），可重复
  --min-stat <number>    Require all stats >= value (1-100)
  --max-stat <number>    Require all stats <= value (1-100)
  --min-total <number>   Require total stats >= value (5-500)
  --max-total <number>   Require total stats <= value (5-500)
  --min-avg <number>     Require average stat >= value (1-100)
  --max-avg <number>     Require average stat <= value (1-100)
  --max <number>         Bun 搜索时表示每个 worker 的最大迭代数；Node 搜索时表示单进程最大迭代数（default: ${DEFAULT_MAX_ITERATIONS})
  --count <number>       Results to find (default: 3)
  --workers <n>          Bun 搜索模式 worker 数；默认按 CPU 自动设置；Node 和 --check 模式下不允许显式设置
  --check <uid>          Check what buddy a specific userID produces（不能与其他搜索参数同用）
  --help, -h             Show this help

Examples:
  bun buddy-reroll.js --species duck --rarity legendary --shiny
  bun buddy-reroll.js --species dragon --min-stats 80
  bun buddy-reroll.js --workers 8 --count 5
  bun buddy-reroll.js --species mushroom --rarity legendary --shiny --count 1 --workers 8
  bun buddy-reroll.js --check f17c2742a00b2345c22fddc830959a6847ceb561fa06adb26b74b1a91ac657bc`)
        process.exit(0)
      default:
        fail(`未知参数: ${arg}`)
    }
  }

  if (opts.species && !SPECIES.includes(opts.species)) {
    fail(`未知物种: ${opts.species}\n可选: ${SPECIES.join(', ')}`)
  }
  if (opts.rarity && !RARITIES.includes(opts.rarity)) {
    fail(`未知稀有度: ${opts.rarity}\n可选: ${RARITIES.join(', ')}`)
  }
  if (opts.eye && !EYES.includes(opts.eye)) {
    fail(`未知眼睛样式: ${opts.eye}\n可选: ${EYES.join(' ')}`)
  }
  if (opts.hat && !HATS.includes(opts.hat)) {
    fail(`未知帽子: ${opts.hat}\n可选: ${HATS.join(', ')}`)
  }

  if (opts.check && hasSearchFilters) {
    fail('--check 不能与其他搜索参数一起使用')
  }
  if (opts.check && workerCountExplicit) {
    fail('--check 模式下不能显式指定 --workers')
  }
  if (!isBun && workerCountExplicit) {
    fail('Node.js 模式下不能显式指定 --workers')
  }

  if (minTotal !== undefined && maxTotal !== undefined && minTotal > maxTotal) {
    fail('--min-total 不能大于 --max-total')
  }
  if (minAvg !== undefined && maxAvg !== undefined && minAvg > maxAvg) {
    fail('--min-avg 不能大于 --max-avg')
  }
  if (minStatFlagValue !== undefined && maxStatFlagValue !== undefined && minStatFlagValue > maxStatFlagValue) {
    fail('--min-stat 不能大于 --max-stat')
  }

  let finalMinStat
  if (minStatFromMinStats !== undefined) finalMinStat = minStatFromMinStats
  if (minStatFlagValue !== undefined) {
    finalMinStat = finalMinStat === undefined ? minStatFlagValue : Math.max(finalMinStat, minStatFlagValue)
  }
  if (finalMinStat !== undefined && maxStatFlagValue !== undefined && finalMinStat > maxStatFlagValue) {
    fail('最终的最小 stat 要求不能大于 --max-stat')
  }

  if (finalMinStat !== undefined) opts.minStat = finalMinStat
  if (minStatFromMinStats !== undefined) opts.minStatsLegacyValue = minStatFromMinStats
  if (minStatFlagValue !== undefined) opts.requestedMinStatValue = minStatFlagValue
  if (maxStatFlagValue !== undefined) opts.maxStat = maxStatFlagValue
  if (minTotal !== undefined) opts.minTotal = minTotal
  if (maxTotal !== undefined) opts.maxTotal = maxTotal
  if (minAvg !== undefined) opts.minAvg = minAvg
  if (maxAvg !== undefined) opts.maxAvg = maxAvg

  if (isBun && !opts.check) {
    opts.workers = workerCountExplicit ? workerCount : getDefaultWorkerCount()
    opts.workers = Math.max(1, opts.workers)
    opts.workersAuto = !workerCountExplicit

    const totalMax = BigInt(opts.workers) * BigInt(opts.max)
    if (totalMax > MAX_SAFE_INTEGER_BIGINT) {
      fail('--workers × --max 超出安全整数范围，请降低参数后重试')
    }
  } else {
    opts.workersAuto = true
  }

  return opts
}

function computeStatsSummary(stats) {
  const values = STAT_NAMES.map(name => stats[name])
  const total = values.reduce((sum, value) => sum + value, 0)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const avg = total / values.length
  return { total, avg, min, max }
}

function matchesStatFilters(stats, filters) {
  for (const filter of filters) {
    const value = stats[filter.name]
    if (filter.op === '>=') {
      if (value < filter.value) return false
    } else if (filter.op === '<=') {
      if (value > filter.value) return false
    } else {
      if (value !== filter.value) return false
    }
  }
  return true
}

function matchesFilters(result, opts, summary) {
  if (opts.rarity && RARITY_RANK[result.rarity] < RARITY_RANK[opts.rarity]) return false
  if (opts.species && result.species !== opts.species) return false
  if (opts.eye && result.eye !== opts.eye) return false
  if (opts.hat && result.hat !== opts.hat) return false
  if (opts.shiny && !result.shiny) return false
  if (!matchesStatFilters(result.stats, opts.statFilters)) return false
  if (opts.minTotal !== undefined && summary.total < opts.minTotal) return false
  if (opts.maxTotal !== undefined && summary.total > opts.maxTotal) return false
  if (opts.minAvg !== undefined && summary.avg < opts.minAvg) return false
  if (opts.maxAvg !== undefined && summary.avg > opts.maxAvg) return false
  if (opts.minStat !== undefined && summary.min < opts.minStat) return false
  if (opts.maxStat !== undefined && summary.max > opts.maxStat) return false
  return true
}

function buildSearchSummary(opts) {
  const parts = []
  if (opts.species) parts.push(`species=${opts.species}`)
  if (opts.rarity) parts.push(`rarity>=${opts.rarity}`)
  if (opts.eye) parts.push(`eye=${opts.eye}`)
  if (opts.hat) parts.push(`hat=${opts.hat}`)
  if (opts.shiny) parts.push('shiny=true')
  if (opts.minStatsLegacyValue !== undefined) parts.push(`min-stats>=${opts.minStatsLegacyValue}`)
  for (const filter of opts.statFilters) {
    parts.push(filter.expr)
  }
  if (opts.minTotal !== undefined) parts.push(`min-total>=${opts.minTotal}`)
  if (opts.maxTotal !== undefined) parts.push(`max-total<=${opts.maxTotal}`)
  if (opts.minAvg !== undefined) parts.push(`min-avg>=${opts.minAvg}`)
  if (opts.maxAvg !== undefined) parts.push(`max-avg<=${opts.maxAvg}`)
  if (opts.requestedMinStatValue !== undefined) parts.push(`min-stat>=${opts.requestedMinStatValue}`)
  if (opts.maxStat !== undefined) parts.push(`max-stat<=${opts.maxStat}`)
  return parts.join(', ')
}

function formatStatsSummary(summary) {
  return `total=${summary.total} avg=${summary.avg.toFixed(1)} min=${summary.min} max=${summary.max}`
}

function printHit(found, uid, result, summary) {
  const statsStr = STAT_NAMES.map(n => `${n}:${result.stats[n]}`).join(' ')
  console.log(`#${found} [${result.rarity}] ${result.species} eye=${result.eye} hat=${result.hat} shiny=${result.shiny}`)
  console.log(`   stats: ${statsStr}`)
  console.log(`   summary: ${formatStatsSummary(summary)}`)
  console.log(`   uid:   ${uid}`)
  console.log('')
}

function runCheckMode(opts, runtimeLabel, rollFull, rarityStars) {
  console.log(`Runtime: ${runtimeLabel}`)
  console.log(`Checking userID: ${opts.check}\n`)
  const r = rollFull(opts.check)
  const summary = computeStatsSummary(r.stats)
  console.log(`  Species : ${r.species}`)
  console.log(`  Rarity  : ${r.rarity} ${rarityStars[r.rarity]}`)
  console.log(`  Eye     : ${r.eye}`)
  console.log(`  Hat     : ${r.hat}`)
  console.log(`  Shiny   : ${r.shiny}`)
  console.log(`  Stats   :`)
  for (const name of STAT_NAMES) {
    const val = r.stats[name]
    const bar = '█'.repeat(Math.floor(val / 5)) + '░'.repeat(20 - Math.floor(val / 5))
    console.log(`    ${name.padEnd(10)} ${bar} ${val}`)
  }
  console.log(`  summary : ${formatStatsSummary(summary)}`)
}

function runSingleProcessSearchLoop(opts, rollFull, onHit) {
  let attempts = 0
  for (let i = 0; i < opts.max; i++) {
    attempts++
    const uid = crypto.randomBytes(32).toString('hex')
    const r = rollFull(uid)
    const summary = computeStatsSummary(r.stats)

    if (!matchesFilters(r, opts, summary)) continue

    const shouldStop = onHit({ uid, result: r, summary, attempts })
    if (shouldStop) break
  }
  return { attempts }
}

function runSingleProcessSearch(opts, runtimeLabel, rollFull) {
  console.log(`Runtime: ${runtimeLabel} (results will NOT match Claude Code)`)
  const searchSummary = buildSearchSummary(opts)
  const summaryDisplay = searchSummary || 'any'
  console.log(`Searching: ${summaryDisplay} (max ${opts.max.toLocaleString()}, find ${opts.count})`)
  console.log('')

  let found = 0
  const startTime = Date.now()
  const { attempts } = runSingleProcessSearchLoop(opts, rollFull, ({ uid, result, summary }) => {
    found++
    printHit(found, uid, result, summary)
    return found >= opts.count
  })

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  if (found === 0) {
    console.log(`No match found in ${opts.max.toLocaleString()} iterations (${elapsed}s)`)
    console.log(`Search summary: ${summaryDisplay}`)
    console.log(`Tried ${attempts.toLocaleString()} draws`)
    console.log(`Time elapsed: ${elapsed}s`)
    console.log('Maybe the filters are too strict, extremely rare, or unattainable under current rules.')
  } else {
    console.log(`Found ${found} match(es) in ${elapsed}s`)
  }
}

async function runBunWorkerSearchLoop(payload, workerControl) {
  const { workerId, opts, workerMax } = payload
  const rollFull = createRoller(hashBun)
  let bufferedAttempts = 0
  let lastReportAt = Date.now()
  let iterationsSinceYield = 0

  const flushAttempts = (force = false) => {
    if (bufferedAttempts <= 0) return
    const now = Date.now()
    if (!force && bufferedAttempts < ATTEMPT_REPORT_INTERVAL && now - lastReportAt < ATTEMPT_REPORT_INTERVAL_MS) {
      return
    }
    self.postMessage({ type: 'attempts', workerId, delta: bufferedAttempts })
    bufferedAttempts = 0
    lastReportAt = now
  }

  const maybeYieldForStop = async () => {
    if (workerControl.stopRequested) return
    if (iterationsSinceYield < WORKER_YIELD_INTERVAL) return
    iterationsSinceYield = 0
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  try {
    for (let i = 0; i < workerMax; i++) {
      if (workerControl.stopRequested) break

      const uid = crypto.randomBytes(32).toString('hex')
      const result = rollFull(uid)
      const summary = computeStatsSummary(result.stats)
      bufferedAttempts++
      iterationsSinceYield++
      flushAttempts(false)
      await maybeYieldForStop()

      if (workerControl.stopRequested) break
      if (!matchesFilters(result, opts, summary)) continue

      flushAttempts(true)
      self.postMessage({ type: 'hit', workerId, uid, result, summary })
    }

    flushAttempts(true)
    self.postMessage({ type: 'done', workerId })
  } catch (error) {
    flushAttempts(true)
    const message = error instanceof Error ? `${error.message}\n${error.stack || ''}`.trim() : String(error)
    self.postMessage({ type: 'fatal', workerId, message })
  }
}

function requestStopBunWorkers(state) {
  if (state.stopRequested) return
  state.stopRequested = true
  for (const workerState of state.workers.values()) {
    if (workerState.stopSent) continue
    workerState.stopSent = true
    try {
      workerState.worker.postMessage({ type: 'stop' })
    } catch {}
  }
}

function terminateBunWorkers(state) {
  for (const workerState of state.workers.values()) {
    if (workerState.terminated) continue
    workerState.terminated = true
    try {
      workerState.worker.terminate()
    } catch {}
  }
}

function formatProgressPercent(totalAttempts, totalMax) {
  if (!Number.isFinite(totalMax) || totalMax <= 0) return 'n/a'
  const percent = Math.min(100, (totalAttempts / totalMax) * 100)
  return `${percent.toFixed(1)}%`
}

function printParallelHeader(state) {
  console.log('Runtime: bun (Bun.hash)')
  console.log(`Workers: ${state.workerCount}${state.workersAuto ? ' (auto)' : ''}`)
  console.log(`Per-worker max: ${state.perWorkerMax.toLocaleString()}`)
  console.log(`Total max: ${state.totalMax.toLocaleString()}`)
  console.log(`Searching: ${state.summaryDisplay}`)
  console.log('')
}

function printBunProgress(state) {
  const now = Date.now()
  const deltaAttempts = state.totalAttempts - state.lastProgressAttempts
  const elapsedMs = Math.max(1, now - state.lastProgressAt)
  const speed = Math.round((deltaAttempts * 1000) / elapsedMs)
  console.log(`Progress: attempts=${state.totalAttempts.toLocaleString()} speed=${speed.toLocaleString()}/s workers=${state.workerCount} progress=${formatProgressPercent(state.totalAttempts, state.totalMax)}`)
  state.lastProgressAttempts = state.totalAttempts
  state.lastProgressAt = now
}

function printBunFinalSummary(state) {
  const elapsed = ((Date.now() - state.startTime) / 1000).toFixed(1)
  if (state.found === 0) {
    console.log(`No match found in ${state.totalAttempts.toLocaleString()} draws across ${state.workerCount} worker(s) (${elapsed}s)`)
    console.log(`Search summary: ${state.summaryDisplay}`)
    console.log(`Time elapsed: ${elapsed}s`)
    console.log('Maybe the filters are too strict, extremely rare, or unattainable under current rules.')
    return
  }
  if (state.found < state.targetCount) {
    console.log(`Found ${state.found}/${state.targetCount} match(es) in ${elapsed}s before exhausting ${state.totalAttempts.toLocaleString()} draws`)
    console.log(`Search summary: ${state.summaryDisplay}`)
    console.log(`Time elapsed: ${elapsed}s`)
    return
  }
  console.log(`Found ${state.found}/${state.targetCount} match(es) in ${elapsed}s using ${state.totalAttempts.toLocaleString()} draws`)
}

function failBunParallelSearch(state, message) {
  if (state.fatal) return
  state.fatal = true
  clearInterval(state.progressTimer)
  terminateBunWorkers(state)
  console.error(`Fatal Bun parallel search error: ${message}`)
  process.exit(1)
}

async function runBunParallelSearch(opts) {
  const searchSummary = buildSearchSummary(opts)
  const summaryDisplay = searchSummary || 'any'
  const workerEntry = Bun.main
  const state = {
    startTime: Date.now(),
    summaryDisplay,
    workerCount: opts.workers,
    workersAuto: Boolean(opts.workersAuto),
    perWorkerMax: opts.max,
    totalMax: opts.workers * opts.max,
    targetCount: opts.count,
    totalAttempts: 0,
    found: 0,
    doneWorkers: 0,
    stopRequested: false,
    fatal: false,
    settled: false,
    lastProgressAt: Date.now(),
    lastProgressAttempts: 0,
    progressTimer: null,
    workers: new Map(),
  }

  printParallelHeader(state)

  const workerPromises = []
  const settlePromise = new Promise((resolve, reject) => {
    const settleSuccess = () => {
      if (state.settled || state.fatal) return
      state.settled = true
      clearInterval(state.progressTimer)
      resolve()
    }

    const settleFatal = message => {
      if (state.settled || state.fatal) return
      state.settled = true
      clearInterval(state.progressTimer)
      reject(new Error(message))
    }

    state.progressTimer = setInterval(() => {
      if (!state.fatal && !state.settled) {
        printBunProgress(state)
      }
    }, PROGRESS_INTERVAL_MS)

    for (let workerId = 1; workerId <= opts.workers; workerId++) {
      const worker = new Worker(workerEntry)
      let resolveDone
      let rejectDone
      const donePromise = new Promise((resolveWorker, rejectWorker) => {
        resolveDone = resolveWorker
        rejectDone = rejectWorker
      })
      workerPromises.push(donePromise)

      const workerState = {
        worker,
        done: false,
        failed: false,
        stopSent: false,
        terminated: false,
        resolveDone,
        rejectDone,
      }
      state.workers.set(workerId, workerState)

      worker.onmessage = event => {
        if (state.fatal) return
        const message = event.data
        if (!message || typeof message !== 'object') return

        if (message.type === 'attempts') {
          state.totalAttempts += message.delta
          return
        }

        if (message.type === 'hit') {
          if (state.settled || state.found >= opts.count) return
          state.found++
          printHit(state.found, message.uid, message.result, message.summary)
          if (state.found >= opts.count) {
            requestStopBunWorkers(state)
          }
          return
        }

        if (message.type === 'done') {
          if (workerState.done || workerState.failed) return
          workerState.done = true
          workerState.resolveDone()
          state.doneWorkers++
          if (state.doneWorkers === state.workerCount) {
            settleSuccess()
          }
          return
        }

        if (message.type === 'fatal') {
          if (workerState.done || workerState.failed) return
          workerState.failed = true
          workerState.rejectDone(new Error(`worker ${message.workerId}: ${message.message}`))
          settleFatal(`worker ${message.workerId}: ${message.message}`)
        }
      }

      worker.onerror = error => {
        const text = error && error.message ? error.message : String(error)
        if (!workerState.done && !workerState.failed) {
          workerState.failed = true
          workerState.rejectDone(new Error(`worker ${workerId} runtime error: ${text}`))
        }
        settleFatal(`worker ${workerId} runtime error: ${text}`)
      }

      worker.postMessage({ type: 'start', workerId, opts, workerMax: opts.max })
    }
  })

  try {
    await settlePromise
    const results = await Promise.allSettled(workerPromises)
    const failures = []
    const missingDone = []
    let index = 0
    for (const [workerId, workerState] of state.workers.entries()) {
      const result = results[index++]
      if (!workerState.done) {
        missingDone.push(workerId)
      }
      if (result && result.status === 'rejected') {
        failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason))
      }
    }
    if (failures.length > 0) {
      failBunParallelSearch(state, failures[0])
      return
    }
    if (missingDone.length > 0) {
      failBunParallelSearch(state, `missing done from worker(s): ${missingDone.join(', ')}`)
      return
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failBunParallelSearch(state, message)
    return
  }

  terminateBunWorkers(state)
  printBunFinalSummary(state)
}

async function main() {
  const opts = parseArgs()

  const isBun = isBunRuntime()
  const hashFn = isBun ? hashBun : hashFNV1a
  const rollFull = createRoller(hashFn)
  const runtimeLabel = isBun ? 'bun (Bun.hash)' : 'node (FNV-1a)'
  const RARITY_STARS = { common: '★', uncommon: '★★', rare: '★★★', epic: '★★★★', legendary: '★★★★★' }

  if (opts.check) {
    runCheckMode(opts, runtimeLabel, rollFull, RARITY_STARS)
    process.exit(0)
  }

  if (isBun) {
    await runBunParallelSearch(opts)
  } else {
    runSingleProcessSearch(opts, runtimeLabel, rollFull)
  }
}

let workerControl = { stopRequested: false, started: false }
if (isBunWorkerRuntime()) {
  self.onmessage = async event => {
    const payload = event.data
    if (!payload || typeof payload !== 'object') return

    if (payload.type === 'stop') {
      workerControl.stopRequested = true
      return
    }

    if (payload.type !== 'start') return
    if (workerControl.started) return

    workerControl.started = true
    workerControl.stopRequested = false
    await runBunWorkerSearchLoop(payload, workerControl)
  }
} else {
  main().catch(error => {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    fail(message)
  })
}
