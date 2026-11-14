import { DELIQUESCENCE_RH, EFFLORESCENCE_RH, SECONDS_PER_DAY, createRandom } from './RustScience.js'

/** Exposure seconds per playback second when the timeline starts (a minute a second). */
export const START_RATE = 60
/** Playback seconds over which the pace grows (exponentially) from `START_RATE` to `secondsPerDay` a day. */
export const RAMP_SECONDS = 40
/** Hour of the day at which the exposure starts: the chamber humidifies the dry specimen into the first night. */
export const START_HOUR = 20
/** Relative humidity of the dry specimen at the start, and how long the chamber takes to humidify it. */
export const START_RH = 0.4
export const HUMIDIFY_SECONDS = 3600
/** Exposure seconds between samples of the climate tables (salt events, growth). */
export const TABLE_STEP = 120
/** The bake's step (exposure seconds) while there is electrolyte, and while there is none. */
export const WET_STEP = 450
export const DRY_STEP = 1200
/** Early snapshots (exposure seconds), before the daily ones: the first hours change fastest. */
const EARLY_SNAPSHOTS = [0, 300, 600, 1200, 2400, 5400, 10800, 21600, 43200]

export interface ClockOptions {
  /** Days of exposure the timeline shows. */
  exposureDays: number
  /** Playback seconds per day of exposure, once the pace has ramped up. */
  secondsPerDay: number
  seed: number
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

/** Index of the last entry of sorted `values` at or before `x` (-1 if none). */
function lastAtOrBefore(values: ArrayLike<number>, x: number) {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (values[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/**
 * The exposure clock and climate of one seed. Timeline time τ maps monotonically onto exposure time t: a minute a
 * second at first, growing to `secondsPerDay` a day over `RAMP_SECONDS`, then steady, so the first hour (deliquescence,
 * microdroplets, the first pits) takes ~25 s and each later day one breath of humidity. Changing the pace only remaps
 * time; the bake runs in exposure time.
 *
 * The climate is a marine diurnal cycle: humid nights (dew, 88–96% RH) and drier afternoons (36–64%; about a third of
 * the days fall below 45%, where NaCl effloresces), with the first afternoon kept above it. The specimen starts dry
 * (40%) at 20:00 and is humidified into the first night over an hour. NaCl deliquesces at 75.3% and stays liquid, as a
 * supersaturated drop, until 45%: the events where that changes are found once, along with a weight of how fast rust
 * grows (wet, and more while drying, as Stratmann found) that spreads each day's growth between its snapshots.
 */
export class RustClock {

  readonly exposureDays: number
  readonly secondsPerDay: number
  readonly seed: number
  /** Exposure seconds the timeline covers. */
  readonly totalExposure: number
  /** Playback seconds the timeline lasts. */
  readonly duration: number
  /** Exposure times at which NaCl deliquesces (RH rises through 75.3%) and effloresces (falls through 45%). */
  readonly deliquescence: number[] = []
  readonly efflorescence: number[] = []
  /** Exposure times of the bake's snapshots, sorted, from 0 to `totalExposure`. */
  readonly snapshotTimes: number[]

  private readonly rate0 = START_RATE
  private readonly rate1: number
  private readonly logRatio: number
  private readonly rampExposure: number
  private readonly dayHigh: number[] = []
  private readonly dayLow: number[] = []
  private readonly growth: Float64Array

  constructor(options: ClockOptions) {
    this.exposureDays = Math.max(options.exposureDays, 0.25)
    this.secondsPerDay = Math.max(options.secondsPerDay, 0.25)
    this.seed = options.seed
    this.totalExposure = this.exposureDays * SECONDS_PER_DAY

    this.rate1 = SECONDS_PER_DAY / this.secondsPerDay
    this.logRatio = Math.log(Math.max(this.rate1 / this.rate0, 1 + 1e-9))
    this.rampExposure = this.rate1 > this.rate0
      ? this.rate0 * RAMP_SECONDS * (this.rate1 / this.rate0 - 1) / this.logRatio
      : 0
    this.duration = this.timelineAt(this.totalExposure)

    const random = createRandom(this.seed * 7919 + 17)
    const days = Math.ceil(this.exposureDays) + 3
    for (let day = 0; day < days; day++) {
      this.dayHigh.push(0.88 + 0.08 * random())
      this.dayLow.push(day === 0 ? 0.52 + 0.1 * random() : 0.36 + 0.28 * random())
    }

    const samples = Math.ceil(this.totalExposure / TABLE_STEP) + 1
    this.growth = new Float64Array(samples + 1)
    let liquid = false
    let previousRH = this.humidityAt(0)
    for (let i = 1; i <= samples; i++) {
      const t = i * TABLE_STEP
      const rh = this.humidityAt(t)
      if (!liquid && rh >= DELIQUESCENCE_RH) {
        liquid = true
        this.deliquescence.push(t - TABLE_STEP * (rh - DELIQUESCENCE_RH) / Math.max(rh - previousRH, 1e-9))
      } else if (liquid && rh <= EFFLORESCENCE_RH) {
        liquid = false
        this.efflorescence.push(t - TABLE_STEP * (EFFLORESCENCE_RH - rh) / Math.max(previousRH - rh, 1e-9))
      }
      const wet = liquid ? smoothstep(0.45, 0.85, rh) : 0.3 * smoothstep(0.6, 0.9, rh)
      const drying = Math.min(Math.max((previousRH - rh) / TABLE_STEP * 3600 / 0.1, 0), 1)
      this.growth[i] = this.growth[i - 1] + wet * (1 + 2 * drying) * TABLE_STEP
      previousRH = rh
    }

    const times = new Set<number>()
    for (const t of EARLY_SNAPSHOTS) if (t < this.totalExposure) times.add(t)
    for (let day = 1; day * SECONDS_PER_DAY < this.totalExposure; day++) times.add(day * SECONDS_PER_DAY)
    times.add(this.totalExposure)
    this.snapshotTimes = [...times].sort((a, b) => a - b)
  }

  /** Exposure seconds at playback second `tau`. */
  exposureAt(tau: number) {
    const t = Math.max(tau, 0)
    if (this.rampExposure <= 0) return this.rate1 * t
    if (t <= RAMP_SECONDS) {
      return this.rate0 * RAMP_SECONDS / this.logRatio * (Math.exp(this.logRatio * t / RAMP_SECONDS) - 1)
    }
    return this.rampExposure + this.rate1 * (t - RAMP_SECONDS)
  }

  /** Playback second at which the exposure reaches `t` seconds. */
  timelineAt(t: number) {
    const exposure = Math.max(t, 0)
    if (this.rampExposure <= 0) return exposure / this.rate1
    if (exposure <= this.rampExposure) {
      return RAMP_SECONDS * Math.log(1 + exposure * this.logRatio / (this.rate0 * RAMP_SECONDS)) / this.logRatio
    }
    return RAMP_SECONDS + (exposure - this.rampExposure) / this.rate1
  }

  /** Hour of the day (0–24) at exposure time `t`. */
  hourOfDay(t: number) {
    return ((START_HOUR + t / 3600) % 24 + 24) % 24
  }

  /** Index of the calendar day (from the start's) at exposure time `t`. */
  dayAt(t: number) {
    return Math.floor((START_HOUR * 3600 + t) / SECONDS_PER_DAY)
  }

  /** Relative humidity (0–1) at exposure time `t`. */
  humidityAt(t: number) {
    const day = Math.max(this.dayAt(t), 0)
    const hour = this.hourOfDay(t)
    const high = this.dayHigh[Math.min(day, this.dayHigh.length - 1)]
    const nextHigh = this.dayHigh[Math.min(day + 1, this.dayHigh.length - 1)]
    const low = this.dayLow[Math.min(day, this.dayLow.length - 1)]
    let rh: number
    if (hour < 7) rh = high
    else if (hour < 11) rh = high + (low - high) * smoothstep(7, 11, hour)
    else if (hour < 16) rh = low
    else if (hour < 21) rh = low + (nextHigh - low) * smoothstep(16, 21, hour)
    else rh = nextHigh
    return START_RH + (rh - START_RH) * smoothstep(0, HUMIDIFY_SECONDS, t)
  }

  /** Exposure time of the last deliquescence at or before `t` (-Infinity before the first). */
  lastDeliquescence(t: number) {
    const index = lastAtOrBefore(this.deliquescence, t)
    return index < 0 ? -Infinity : this.deliquescence[index]
  }

  /** Exposure time of the last efflorescence at or before `t` (-Infinity before the first). */
  lastEfflorescence(t: number) {
    const index = lastAtOrBefore(this.efflorescence, t)
    return index < 0 ? -Infinity : this.efflorescence[index]
  }

  /** Whether NaCl deposited before the last deliquescence is a drop (true) or a crystal (false) at `t`. */
  saltLiquid(t: number) {
    return this.lastDeliquescence(t) > this.lastEfflorescence(t)
  }

  /** Whether there is electrolyte to step for at `t`: salt drops, or humid enough for rust to hold water. */
  wetAt(t: number) {
    return this.saltLiquid(t) || this.humidityAt(t) > 0.6
  }

  /** Exposure time of the first snapshot after `t` (`totalExposure` past the last). */
  nextSnapshot(t: number) {
    const index = lastAtOrBefore(this.snapshotTimes, t) + 1
    return index < this.snapshotTimes.length ? this.snapshotTimes[index] : this.totalExposure
  }

  /**
   * The bake's next step from `t`: 10 s at first, growing with the time elapsed to `WET_STEP` while there is
   * electrolyte, `DRY_STEP` while there is none, never past the next snapshot or the end.
   */
  stepSize(t: number) {
    const wet = this.wetAt(t)
    const base = t < 600 ? 10 : Math.min(Math.max(t * 0.05, 10), WET_STEP)
    const step = wet ? base : Math.max(base, DRY_STEP)
    return Math.max(Math.min(step, this.nextSnapshot(t) - t, this.totalExposure - t), 0)
  }

  /** How far (0–1) the growth between exposure times `a` and `b` has come by `t`, by the growth weight. */
  growthProgress(a: number, b: number, t: number) {
    if (b <= a) return 1
    const ga = this.growthAt(a)
    const gb = this.growthAt(b)
    const linear = Math.min(Math.max((t - a) / (b - a), 0), 1)
    if (gb - ga < 1e-6) return linear
    return Math.min(Math.max((this.growthAt(t) - ga) / (gb - ga), 0), 1)
  }

  /**
   * The two snapshots to show exposure time `t` from, and how far between them it is (along the growth curve):
   * `{a, b, weight}` as snapshot indices.
   */
  snapshotBlend(t: number) {
    const times = this.snapshotTimes
    const index = Math.max(lastAtOrBefore(times, t), 0)
    if (index >= times.length - 1) return {a: times.length - 1, b: times.length - 1, weight: 0}
    return {a: index, b: index + 1, weight: this.growthProgress(times[index], times[index + 1], t)}
  }

  private growthAt(t: number) {
    const x = Math.min(Math.max(t / TABLE_STEP, 0), this.growth.length - 1)
    const i = Math.min(Math.floor(x), this.growth.length - 2)
    return this.growth[i] + (this.growth[i + 1] - this.growth[i]) * (x - i)
  }
}
