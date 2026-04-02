#!/usr/bin/env bun
'use strict'

const os = require('node:os')
const { pathToFileURL } = require('node:url')

const SPECIES = ['duck', 'goose', 'blob', 'cat', 'dragon', 'octopus', 'owl', 'penguin', 'turtle', 'snail', 'ghost', 'axolotl', 'capybara', 'cactus', 'robot', 'rabbit', 'mushroom', 'chonk']
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary']
const RARITY_WEIGHTS = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 }
const RARITY_RANK = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 }
const EYES = ['·', '✦', '×', '◉', '@', '°']
const HATS = ['none', 'crown', 'tophat', 'propeller', 'halo', 'wizard', 'beanie', 'tinyduck']
const STAT_NAMES = ['DEBUGGING', 'PATIENCE', 'CHAOS', 'WISDOM', 'SNARK']
const RARITY_FLOOR = { common: 5, uncommon: 15, rare: 25, epic: 35, legendary: 50 }
const RARITY_STARS = { common: '★', uncommon: '★★', rare: '★★★', epic: '★★★★', legendary: '★★★★★' }
const UINT32_MAX = 4294967295
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)
const ATTEMPT_REPORT_INTERVAL = 100_000
const ATTEMPT_REPORT_INTERVAL_MS = 1_000
const WORKER_YIELD_INTERVAL = 1_000
const workerControl = { stopRequested: false, started: false }

function fail(message) {
  console.error(message)
  process.exit(1)
}

function printHelp() {
  console.log(`Usage:
  bun buddy-seed-search.js [options]

Check modes:
  bun buddy-seed-search.js --check-seed <n>
  bun buddy-seed-search.js --check-id seed:<n>

Filters:
  --species <name>       ${SPECIES.join(', ')}
  --rarity <name>        Minimum rarity: ${RARITIES.join(', ')}
  --eye <char>           ${EYES.join(' ')}
  --hat <name>           ${HATS.join(', ')}
  --shiny                Require shiny
  --min-stats [value]    Require ALL stats >= value (default: 90)
  --stat <expr>          Add a stat comparison (STAT>=value, STAT<=value, STAT=value)
  --min-stat <number>    Require all stats >= value (1-100)
  --max-stat <number>    Require all stats <= value (1-100)
  --min-total <number>   Require total stats >= value (5-500)
  --max-total <number>   Require total stats <= value (5-500)
  --min-avg <number>     Require average stat >= value (1-100)
  --max-avg <number>     Require average stat <= value (1-100)

Range search:
  --start-seed <n>       Start seed in closed interval 0..${UINT32_MAX}
  --end-seed <n>         End seed in closed interval 0..${UINT32_MAX}
  --workers <n>          Worker count in range-search mode (default: auto by CPU)
  --progress-every <n>   Report progress every N seconds (must be >= 1)
  --count <n>            Number of results to find (default: 3)
  --exhaustive           Scan the full requested range even after enough hits are found

Other:
  --help, -h             Show this help

Notes:
  - local pseudo-ID format is only seed:<n>
  - --check-seed / --check-id cannot be combined with any filter or range flags
  - --check-seed and --check-id are mutually exclusive
  - non-exhaustive parallel search returns the first matches observed by workers, not the lowest seeds in sorted order`)
}

function parseStrictInt(token, label, { min, max } = {}) {
  if (!/^[0-9]+$/.test(token)) {
    fail(`${label} must be a decimal integer (received: ${token})`)
  }
  const bigValue = BigInt(token)
  if (bigValue > MAX_SAFE_INTEGER_BIGINT) {
    fail(`${label} exceeds safe integer range (<= ${Number.MAX_SAFE_INTEGER})`)
  }
  const value = Number(bigValue)
  if (min !== undefined && value < min) fail(`${label} must be >= ${min}`)
  if (max !== undefined && value > max) fail(`${label} must be <= ${max}`)
  return value
}

function parseSeedValue(token, label) {
  return parseStrictInt(token, label, { min: 0, max: UINT32_MAX })
}

function readArgValue(args, index, flag, { allowLeadingDash = false } = {}) {
  const next = args[index + 1]
  if (next === undefined || (!allowLeadingDash && next.startsWith('--'))) {
    fail(`${flag} requires a value`)
  }
  if (next === '') {
    fail(`${flag} requires a non-empty value`)
  }
  return next
}

function isBunRuntime() {
  return typeof Bun !== 'undefined'
}

function isBunWorkerRuntime() {
  return isBunRuntime() && Bun.isMainThread === false
}

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
  for (const rarity of RARITIES) {
    roll -= RARITY_WEIGHTS[rarity]
    if (roll < 0) return rarity
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

function rollFromSeed(seed) {
  const pseudoId = toPseudoId(seed)
  const rng = mulberry32(seed)
  const rarity = rollRarity(rng)
  return {
    pseudoId,
    seed,
    rarity,
    species: pick(rng, SPECIES),
    eye: pick(rng, EYES),
    hat: rarity === 'common' ? 'none' : pick(rng, HATS),
    shiny: rng() < 0.01,
    stats: rollStats(rng, rarity),
  }
}

function toPseudoId(seed) {
  return `seed:${seed}`
}

function parseCheckId(value) {
  const match = /^seed:(\d+)$/.exec(value)
  if (!match) {
    fail(`invalid --check-id value: ${value} (expected seed:<n>)`)
  }
  return parseSeedValue(match[1], '--check-id seed')
}

function parseStatFilter(expr) {
  const trimmed = expr.trim()
  const match = /^([A-Z]+)\s*(>=|<=|=)\s*(\d+)$/.exec(trimmed)
  if (!match) fail(`invalid --stat expression: ${expr}`)
  const name = match[1]
  if (!STAT_NAMES.includes(name)) {
    fail(`unknown stat: ${name}\navailable stats: ${STAT_NAMES.join(', ')}`)
  }
  const value = parseStrictInt(match[3], '--stat value', { min: 1, max: 100 })
  return { name, op: match[2], value, expr: `${name}${match[2]}${value}` }
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
    } else if (value !== filter.value) {
      return false
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
  for (const filter of opts.statFilters) parts.push(filter.expr)
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

function getDefaultWorkerCount() {
  let cpuCount = 1
  if (typeof os.availableParallelism === 'function') cpuCount = os.availableParallelism()
  else if (Array.isArray(os.cpus()) && os.cpus().length > 0) cpuCount = os.cpus().length
  return cpuCount > 1 ? cpuCount - 1 : 1
}

function splitSeedRange(startSeed, endSeed, requestedWorkers) {
  const totalSeeds = endSeed - startSeed + 1
  const actualWorkers = Math.max(1, Math.min(requestedWorkers, totalSeeds))
  const baseSize = Math.floor(totalSeeds / actualWorkers)
  const remainder = totalSeeds % actualWorkers
  const ranges = []
  let nextStart = startSeed

  for (let index = 0; index < actualWorkers; index++) {
    const size = baseSize + (index < remainder ? 1 : 0)
    const rangeStart = nextStart
    const rangeEnd = rangeStart + size - 1
    ranges.push({ startSeed: rangeStart, endSeed: rangeEnd })
    nextStart = rangeEnd + 1
  }

  return { totalSeeds, actualWorkers, ranges }
}

function formatWorkerCount(opts, actualWorkers) {
  if (opts.workersAuto) {
    return actualWorkers === opts.workers ? `${actualWorkers} (auto)` : `${actualWorkers} (auto, capped from ${opts.workers})`
  }
  if (opts.workersExplicit && actualWorkers !== opts.workers) {
    return `${actualWorkers} (requested ${opts.workers})`
  }
  return String(actualWorkers)
}

function formatNumber(value) {
  return value.toLocaleString('en-US')
}

function printCheckResult(result, runtimeLabel) {
  const summary = computeStatsSummary(result.stats)
  console.log(`Runtime: ${runtimeLabel}`)
  console.log(`Checking local pseudo-ID: ${result.pseudoId}`)
  console.log(`Seed: ${result.seed}`)
  console.log('')
  console.log(`  Species : ${result.species}`)
  console.log(`  Rarity  : ${result.rarity} ${RARITY_STARS[result.rarity]}`)
  console.log(`  Eye     : ${result.eye}`)
  console.log(`  Hat     : ${result.hat}`)
  console.log(`  Shiny   : ${result.shiny}`)
  console.log('  Stats   :')
  for (const name of STAT_NAMES) {
    const value = result.stats[name]
    const bar = '█'.repeat(Math.floor(value / 5)) + '░'.repeat(20 - Math.floor(value / 5))
    console.log(`    ${name.padEnd(10)} ${bar} ${value}`)
  }
  console.log(`  summary : ${formatStatsSummary(summary)}`)
  console.log(`  localId : ${result.pseudoId}`)
}

function printHit(hitNumber, result, summary) {
  console.log(`#${hitNumber} seed=${result.seed} local-id=${result.pseudoId}`)
  console.log(`  species: ${result.species}`)
  console.log(`  rarity: ${result.rarity} ${RARITY_STARS[result.rarity]}`)
  console.log(`  eye: ${result.eye}`)
  console.log(`  hat: ${result.hat}`)
  console.log(`  shiny: ${result.shiny}`)
  console.log('  stats:')
  for (const name of STAT_NAMES) {
    console.log(`    ${name}: ${result.stats[name]}`)
  }
  console.log(`  summary: ${formatStatsSummary(summary)}`)
  console.log('')
}

function createBunWorker() {
  return new Worker(pathToFileURL(__filename).href)
}

async function terminateWorker(worker) {
  try {
    await worker.terminate()
  } catch {
  }
}

async function terminateWorkers(workers) {
  await Promise.allSettled(workers.map(({ worker }) => terminateWorker(worker)))
}

async function runRangeSearch(opts) {
  if (!isBunRuntime()) {
    fail('Range search mode requires Bun runtime; use bun for --start-seed/--end-seed searches.')
  }

  const searchSummary = buildSearchSummary(opts) || 'any'
  const { totalSeeds, actualWorkers, ranges } = splitSeedRange(opts.startSeed, opts.endSeed, opts.workers)
  const startedAt = Date.now()
  const workers = []
  const workerSettled = new Map()
  let scannedSeeds = 0
  let found = 0
  let printedHits = 0
  let settledWorkers = 0
  let progressTimer = null
  let stopRequested = false
  let stopSent = false
  let fatalError = null
  let fatalMessagePrinted = false
  let fullRangeExhausted = true
  let lastProgressAt = startedAt
  let lastProgressSeeds = 0

  const stopProgressTimer = () => {
    if (progressTimer !== null) {
      clearInterval(progressTimer)
      progressTimer = null
    }
  }

  const printProgress = () => {
    if (fatalError) return
    const now = Date.now()
    const windowSeconds = Math.max((now - lastProgressAt) / 1000, 0.001)
    const speed = (scannedSeeds - lastProgressSeeds) / windowSeconds
    const progress = Math.min(100, (scannedSeeds / totalSeeds) * 100)
    console.log(`Progress: seeds=${formatNumber(scannedSeeds)}/${formatNumber(totalSeeds)} speed=${speed.toFixed(1)}/s workers=${actualWorkers} progress=${progress.toFixed(2)}%`)
    lastProgressAt = now
    lastProgressSeeds = scannedSeeds
  }

  const requestStopAllWorkers = () => {
    if (stopSent) return
    stopSent = true
    stopRequested = true
    for (const entry of workers) {
      entry.worker.postMessage({ type: 'stop' })
    }
  }

  const handleWorkerFatal = async (workerId, errorMessage) => {
    if (fatalError) return
    fatalError = `Fatal: worker-${workerId} failed: ${errorMessage}`
    stopProgressTimer()
    await terminateWorkers(workers.filter(entry => entry.id !== workerId))
    if (!fatalMessagePrinted) {
      fatalMessagePrinted = true
      console.error(fatalError)
    }
  }

  console.log('Runtime: bun (seed-space)')
  console.log(`Workers: ${formatWorkerCount(opts, actualWorkers)}`)
  console.log(`Seed range: ${opts.startSeed}..${opts.endSeed}`)
  console.log(`Total seeds: ${formatNumber(totalSeeds)}`)
  console.log(`Searching: ${searchSummary}`)
  console.log('')

  progressTimer = setInterval(printProgress, opts.progressEvery * 1000)

  await new Promise((resolve, reject) => {
    for (let index = 0; index < ranges.length; index++) {
      const workerId = index + 1
      const range = ranges[index]
      let worker
      try {
        worker = createBunWorker()
      } catch (error) {
        reject(new Error(`Fatal: worker-${workerId} failed to initialize: ${error && error.message ? error.message : String(error)}`))
        return
      }
      const entry = { id: workerId, worker }
      workers.push(entry)
      workerSettled.set(workerId, false)

      worker.onmessage = async event => {
        const message = event.data
        if (fatalError) return

        if (message.type === 'progress') {
          scannedSeeds += message.scanned
          return
        }

        if (message.type === 'hit') {
          found += 1
          if (opts.exhaustive || printedHits < opts.count) {
            printedHits += 1
            printHit(printedHits, message.result, message.summary)
          }
          if (!opts.exhaustive && found >= opts.count) {
            requestStopAllWorkers()
          }
          return
        }

        if (message.type === 'done') {
          if (!workerSettled.get(workerId)) {
            workerSettled.set(workerId, true)
            settledWorkers += 1
            if (message.stoppedEarly) fullRangeExhausted = false
          }
          if (settledWorkers === actualWorkers) {
            resolve()
          }
          return
        }

        if (message.type === 'fatal') {
          try {
            await handleWorkerFatal(workerId, message.error)
            reject(new Error(fatalError))
          } catch (error) {
            reject(error)
          }
        }
      }

      worker.onerror = async error => {
        try {
          await handleWorkerFatal(workerId, error.message || String(error))
          reject(new Error(fatalError))
        } catch (fatal) {
          reject(fatal)
        }
      }

      worker.postMessage({ type: 'start', workerId, range, opts })
    }
  }).finally(async () => {
    stopProgressTimer()
    await terminateWorkers(workers)
  })

  if (fatalError) {
    process.exitCode = 1
    return
  }

  printProgress()
  const classification = classifySearchResult({
    exhaustive: opts.exhaustive,
    fullRangeExhausted,
    found,
    requestedCount: opts.count,
    earlyStopOccurred: stopRequested && !fullRangeExhausted,
  })

  console.log(`Result: ${classification}`)
  console.log(`Found: ${formatNumber(found)}`)
  console.log(`Scanned seeds: ${formatNumber(scannedSeeds)}/${formatNumber(totalSeeds)}`)
}

function classifySearchResult({ exhaustive, fullRangeExhausted, found, requestedCount, earlyStopOccurred }) {
  if (fullRangeExhausted && found === 0) return 'no-result'
  if (fullRangeExhausted && found > 0 && found < requestedCount) return 'partial-result'
  if (!exhaustive && found >= requestedCount && earlyStopOccurred) return 'success'
  if (exhaustive && fullRangeExhausted && found >= requestedCount) return 'success'
  return 'partial-result'
}

async function runWorkerLoop(message) {
  if (!message || message.type !== 'start') {
    self.postMessage({ type: 'fatal', error: 'worker received invalid start payload' })
    return
  }

  const { workerId, range, opts } = message
  let pendingScanned = 0
  let lastReportAt = Date.now()
  let stoppedEarly = false

  const flushProgress = (now = Date.now()) => {
    if (pendingScanned === 0) return
    self.postMessage({ type: 'progress', workerId, scanned: pendingScanned })
    pendingScanned = 0
    lastReportAt = now
  }

  try {
    for (let seed = range.startSeed; seed <= range.endSeed; seed++) {
      if (workerControl.stopRequested) {
        stoppedEarly = true
        break
      }

      const result = rollFromSeed(seed)
      const summary = computeStatsSummary(result.stats)
      pendingScanned += 1

      if (matchesFilters(result, opts, summary)) {
        self.postMessage({ type: 'hit', workerId, result, summary })
        if (!opts.exhaustive) {
          flushProgress(Date.now())
          await Bun.sleep(0)
          if (workerControl.stopRequested) {
            stoppedEarly = true
            break
          }
        }
      }

      const attempts = seed - range.startSeed + 1
      const now = Date.now()
      if (pendingScanned >= ATTEMPT_REPORT_INTERVAL || now - lastReportAt >= ATTEMPT_REPORT_INTERVAL_MS) {
        flushProgress(now)
      }

      if (attempts % WORKER_YIELD_INTERVAL === 0) {
        flushProgress(Date.now())
        await Bun.sleep(0)
      }
    }

    flushProgress(Date.now())
    self.postMessage({ type: 'done', workerId, stoppedEarly })
  } catch (error) {
    self.postMessage({ type: 'fatal', workerId, error: error && error.message ? error.message : String(error) })
  }
}

function setupBunWorkerRuntime() {
  self.onmessage = event => {
    const message = event.data

    if (!message || typeof message.type !== 'string') {
      self.postMessage({ type: 'fatal', error: 'worker received malformed message' })
      return
    }

    if (message.type === 'stop') {
      workerControl.stopRequested = true
      return
    }

    if (message.type === 'start') {
      if (workerControl.started) {
        self.postMessage({ type: 'fatal', error: 'worker received duplicate start message' })
        return
      }
      workerControl.started = true
      runWorkerLoop(message)
      return
    }

    self.postMessage({ type: 'fatal', error: `worker received unknown message type: ${message.type}` })
  }
}

function parseArgs(argv) {
  const opts = {
    statFilters: [],
    startSeed: 0,
    endSeed: UINT32_MAX,
    progressEvery: 60,
    count: 3,
    workersAuto: true,
    workersExplicit: false,
    exhaustive: false,
  }

  let minStatFromMinStats
  let minStatFlagValue
  let maxStatFlagValue
  let minTotal
  let maxTotal
  let minAvg
  let maxAvg

  const checkFlags = []
  const nonCheckFlags = []
  let startSeedProvided = false
  let endSeedProvided = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--species':
        opts.species = readArgValue(argv, i, '--species')
        nonCheckFlags.push('--species')
        i++
        break
      case '--rarity':
        opts.rarity = readArgValue(argv, i, '--rarity')
        nonCheckFlags.push('--rarity')
        i++
        break
      case '--eye':
        opts.eye = readArgValue(argv, i, '--eye')
        nonCheckFlags.push('--eye')
        i++
        break
      case '--hat':
        opts.hat = readArgValue(argv, i, '--hat')
        nonCheckFlags.push('--hat')
        i++
        break
      case '--shiny':
        opts.shiny = true
        nonCheckFlags.push('--shiny')
        break
      case '--min-stats': {
        const next = argv[i + 1]
        let value
        if (next === undefined || next.startsWith('--')) {
          value = 90
        } else if (next === '') {
          fail('--min-stats requires a non-empty value')
        } else {
          value = parseStrictInt(next, '--min-stats', { min: 1, max: 100 })
          i++
        }
        minStatFromMinStats = value
        nonCheckFlags.push('--min-stats')
        break
      }
      case '--stat':
        opts.statFilters.push(parseStatFilter(readArgValue(argv, i, '--stat')))
        nonCheckFlags.push('--stat')
        i++
        break
      case '--min-stat':
        minStatFlagValue = parseStrictInt(readArgValue(argv, i, '--min-stat'), '--min-stat', { min: 1, max: 100 })
        nonCheckFlags.push('--min-stat')
        i++
        break
      case '--max-stat':
        maxStatFlagValue = parseStrictInt(readArgValue(argv, i, '--max-stat'), '--max-stat', { min: 1, max: 100 })
        nonCheckFlags.push('--max-stat')
        i++
        break
      case '--min-total':
        minTotal = parseStrictInt(readArgValue(argv, i, '--min-total'), '--min-total', { min: 5, max: 500 })
        nonCheckFlags.push('--min-total')
        i++
        break
      case '--max-total':
        maxTotal = parseStrictInt(readArgValue(argv, i, '--max-total'), '--max-total', { min: 5, max: 500 })
        nonCheckFlags.push('--max-total')
        i++
        break
      case '--min-avg':
        minAvg = parseStrictInt(readArgValue(argv, i, '--min-avg'), '--min-avg', { min: 1, max: 100 })
        nonCheckFlags.push('--min-avg')
        i++
        break
      case '--max-avg':
        maxAvg = parseStrictInt(readArgValue(argv, i, '--max-avg'), '--max-avg', { min: 1, max: 100 })
        nonCheckFlags.push('--max-avg')
        i++
        break
      case '--start-seed':
        opts.startSeed = parseSeedValue(readArgValue(argv, i, '--start-seed'), '--start-seed')
        startSeedProvided = true
        nonCheckFlags.push('--start-seed')
        i++
        break
      case '--end-seed':
        opts.endSeed = parseSeedValue(readArgValue(argv, i, '--end-seed'), '--end-seed')
        endSeedProvided = true
        nonCheckFlags.push('--end-seed')
        i++
        break
      case '--workers':
        opts.workers = parseStrictInt(readArgValue(argv, i, '--workers'), '--workers', { min: 1 })
        opts.workersExplicit = true
        opts.workersAuto = false
        nonCheckFlags.push('--workers')
        i++
        break
      case '--progress-every':
        opts.progressEvery = parseStrictInt(readArgValue(argv, i, '--progress-every'), '--progress-every', { min: 1 })
        nonCheckFlags.push('--progress-every')
        i++
        break
      case '--count':
        opts.count = parseStrictInt(readArgValue(argv, i, '--count'), '--count', { min: 1 })
        nonCheckFlags.push('--count')
        i++
        break
      case '--exhaustive':
        opts.exhaustive = true
        nonCheckFlags.push('--exhaustive')
        break
      case '--check-seed':
        opts.checkSeed = parseSeedValue(readArgValue(argv, i, '--check-seed', { allowLeadingDash: true }), '--check-seed')
        checkFlags.push('--check-seed')
        i++
        break
      case '--check-id':
        opts.checkId = readArgValue(argv, i, '--check-id', { allowLeadingDash: true })
        checkFlags.push('--check-id')
        i++
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
      default:
        fail(`unknown argument: ${arg}`)
    }
  }

  if (opts.species && !SPECIES.includes(opts.species)) {
    fail(`unknown species: ${opts.species}\navailable: ${SPECIES.join(', ')}`)
  }
  if (opts.rarity && !RARITIES.includes(opts.rarity)) {
    fail(`unknown rarity: ${opts.rarity}\navailable: ${RARITIES.join(', ')}`)
  }
  if (opts.eye && !EYES.includes(opts.eye)) {
    fail(`unknown eye style: ${opts.eye}\navailable: ${EYES.join(' ')}`)
  }
  if (opts.hat && !HATS.includes(opts.hat)) {
    fail(`unknown hat: ${opts.hat}\navailable: ${HATS.join(', ')}`)
  }

  if (checkFlags.length > 1) {
    fail('--check-seed and --check-id are mutually exclusive')
  }
  if (checkFlags.length === 1 && nonCheckFlags.length > 0) {
    fail(`${checkFlags[0]} cannot be combined with filter or range flags`)
  }

  if (opts.checkId !== undefined) {
    opts.checkSeed = parseCheckId(opts.checkId)
  }

  if (minTotal !== undefined && maxTotal !== undefined && minTotal > maxTotal) {
    fail('--min-total cannot be greater than --max-total')
  }
  if (minAvg !== undefined && maxAvg !== undefined && minAvg > maxAvg) {
    fail('--min-avg cannot be greater than --max-avg')
  }
  if (minStatFlagValue !== undefined && maxStatFlagValue !== undefined && minStatFlagValue > maxStatFlagValue) {
    fail('--min-stat cannot be greater than --max-stat')
  }

  let finalMinStat
  if (minStatFromMinStats !== undefined) finalMinStat = minStatFromMinStats
  if (minStatFlagValue !== undefined) {
    finalMinStat = finalMinStat === undefined ? minStatFlagValue : Math.max(finalMinStat, minStatFlagValue)
  }
  if (finalMinStat !== undefined && maxStatFlagValue !== undefined && finalMinStat > maxStatFlagValue) {
    fail('final minimum stat requirement cannot be greater than --max-stat')
  }

  if (finalMinStat !== undefined) opts.minStat = finalMinStat
  if (minStatFromMinStats !== undefined) opts.minStatsLegacyValue = minStatFromMinStats
  if (minStatFlagValue !== undefined) opts.requestedMinStatValue = minStatFlagValue
  if (maxStatFlagValue !== undefined) opts.maxStat = maxStatFlagValue
  if (minTotal !== undefined) opts.minTotal = minTotal
  if (maxTotal !== undefined) opts.maxTotal = maxTotal
  if (minAvg !== undefined) opts.minAvg = minAvg
  if (maxAvg !== undefined) opts.maxAvg = maxAvg

  if ((startSeedProvided || endSeedProvided) && opts.startSeed > opts.endSeed) {
    fail('--start-seed cannot be greater than --end-seed')
  }

  if (checkFlags.length === 0) {
    if (!opts.workersExplicit) {
      opts.workers = getDefaultWorkerCount()
      opts.workersAuto = true
    }
  } else {
    delete opts.workers
    opts.workersAuto = false
  }

  return opts
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const runtimeLabel = isBunRuntime() ? 'bun (seed-space)' : 'node (seed-space)'

  if (opts.checkSeed !== undefined) {
    printCheckResult(rollFromSeed(opts.checkSeed), runtimeLabel)
    return
  }

  await runRangeSearch(opts)
}

if (isBunWorkerRuntime()) {
  setupBunWorkerRuntime()
} else {
  main().catch(error => {
    const message = error && error.message ? error.message : String(error)
    if (!/^Fatal: worker-\d+ failed:/.test(message) && !/^Fatal: worker-\d+ failed to initialize:/.test(message)) {
      fail(message)
      return
    }
    process.exitCode = 1
  })
}
