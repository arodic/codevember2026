import {
  NACL_MOLAR_MASS, SECONDS_PER_DAY, capAngle, capBaseRadius, capHeight, createRandom, dropVolume, gaussian,
  naclMolality, saltCubeMass,
} from './RustScience.js'
import type { RustClock } from './RustClock.js'

/** Side (µm) of the whole specimen surface simulated (the surround grid), centred on the hero crystal. */
export const SURROUND_SIZE = 2560
/** Side (µm) of the finely simulated core around the hero crystal. */
export const CORE_SIZE = 640
/** Contact angles of NaCl brine on polished steel: advancing, and receding (below which a pinned drop lets go). */
export const ADVANCING_ANGLE = 45 * Math.PI / 180
export const RECEDING_ANGLE = 10 * Math.PI / 180
/** Contact angle of the alkaline microdroplets of secondary spreading. */
export const MICRO_ANGLE = 30 * Math.PI / 180
/** Base radius (µm) above which a drop corrodes and spreads (Li & Hihara: 40–100 µm drops on low-carbon steel). */
export const CRITICAL_RADIUS = 40
/** How far (µm) the secondary-spreading film reaches past the edge of an 80 µm drop, and its time constant (s). */
export const SPREAD_REACH = 150
export const SPREAD_TIME = 900
/** Slots for large drops on the GPU (the hero, its neighbours). */
export const MAX_LARGE_DROPS = 8
/** Exposure seconds between the drop model's samples. */
export const DROP_STEP = 120
/** Relative humidity at which microdroplet sizes are given. */
const MICRO_REFERENCE_RH = 0.9

export interface SaltOptions {
  seed: number
  /** Edge (µm) of the hero NaCl crystal. */
  heroEdge: number
  /** NaCl on the surface at the start (µg/cm²), the hero and its neighbours aside. */
  saltLoad: number
  /** Chloride deposited per day (mg/m²/day, as sea spray adds it; ~60 is the akaganeite threshold). */
  chlorideDeposition: number
  /** Days of exposure (for daily deposition). */
  exposureDays: number
}

/** An NaCl crystal (a cube) landing on the surface. */
export interface SaltDeposit {
  x: number
  z: number
  /** Edge (µm). */
  edge: number
  /** Exposure time (s) it lands at; negative = there at the start. */
  time: number
}

/** One of the alkaline microdroplets that condense around a corroding drop (secondary spreading). */
export interface Microdroplet {
  x: number
  z: number
  /** Base radius (µm) at 90% RH. */
  radius: number
  /** Distance (µm) from its parent drop's largest footprint, which the spreading film has to reach. */
  distance: number
  /** Index of the large deposit it belongs to. */
  parent: number
}

export interface SaltField {
  /** Small crystals, at the start and landing daily: they make sub-critical drops. */
  small: SaltDeposit[]
  /** The hero (index 0) and its neighbours, in slot order. */
  large: SaltDeposit[]
  micro: Microdroplet[]
}

/** Base radius (µm) of a drop of `edge` µm of NaCl at `rh` resting at the advancing angle. */
function restingRadius(edge: number, rh: number) {
  return capBaseRadius(dropVolume(saltCubeMass(edge), rh), ADVANCING_ANGLE)
}

/** Edges (µm) of small sea-salt crystals: log-normal around 3 µm, 1–12 µm. */
function smallEdge(random: () => number) {
  return Math.min(Math.max(3 * Math.exp(0.6 * gaussian(random)), 1), 12)
}

/**
 * The salt on the specimen for a seed: the hero crystal near the centre, one neighbour within the core (their rings
 * meet), three more out in the surround, a scatter of small crystals at the start (`saltLoad`), and small crystals
 * landing through each day (`chlorideDeposition`). Around each large deposit, the microdroplets its secondary-spreading
 * film will condense, smaller the farther out (Frontiers in Chemistry 2021), placed without overlaps.
 */
export function generateSalt(options: SaltOptions): SaltField {
  const random = createRandom(options.seed * 4271 + 3)
  const half = SURROUND_SIZE / 2
  const large: SaltDeposit[] = [{x: (random() - 0.5) * 20, z: (random() - 0.5) * 20, edge: options.heroEdge, time: -1}]
  const coreAngle = random() * Math.PI * 2
  const coreDistance = 200 + 60 * random()
  large.push({
    x: large[0].x + Math.cos(coreAngle) * coreDistance, z: large[0].z + Math.sin(coreAngle) * coreDistance,
    edge: 18 + 4 * random(), time: -1,
  })
  for (let n = 0, attempts = 0; n < 3 && attempts < 400; attempts++) {
    const angle = random() * Math.PI * 2
    const distance = 620 + 480 * random()
    const x = Math.cos(angle) * distance
    const z = Math.sin(angle) * distance
    if (Math.abs(x) > half - 200 || Math.abs(z) > half - 200) continue
    if (large.some(d => Math.hypot(d.x - x, d.z - z) < 380)) continue
    large.push({x, z, edge: 15 + 10 * random(), time: -1})
    n++
  }

  const footprints = large.map(d => restingRadius(d.edge, 0.97) + 10)
  const area = (SURROUND_SIZE * 1e-4) ** 2
  const small: SaltDeposit[] = []
  const scatter = (micrograms: number, time: (random: () => number) => number, avoidLarge: boolean) => {
    let mass = 0
    for (let attempts = 0; mass < micrograms * 1e-6 && attempts < 400000; attempts++) {
      const x = (random() * 2 - 1) * (half - 8)
      const z = (random() * 2 - 1) * (half - 8)
      if (avoidLarge && large.some((d, i) => Math.hypot(d.x - x, d.z - z) < footprints[i])) continue
      const edge = smallEdge(random)
      small.push({x, z, edge, time: time(random)})
      mass += saltCubeMass(edge)
    }
  }
  scatter(options.saltLoad * area, () => -1, true)
  const chloridePerDay = options.chlorideDeposition * NACL_MOLAR_MASS / 35.453 * 1e3 * area * 1e-4
  const days = Math.ceil(options.exposureDays)
  for (let day = 0; day < days; day++) {
    scatter(chloridePerDay, r => (day + r()) * SECONDS_PER_DAY, false)
  }
  small.sort((a, b) => a.time - b.time)

  const micro: Microdroplet[] = []
  large.forEach((deposit, parent) => {
    const edgeRadius = restingRadius(deposit.edge, MICRO_REFERENCE_RH)
    if (edgeRadius < CRITICAL_RADIUS) return
    const reach = SPREAD_REACH * Math.sqrt(edgeRadius / 80) * 1.1
    const own: Microdroplet[] = []
    for (let attempts = 0; attempts < 9000 && own.length < 900; attempts++) {
      const distance = reach * Math.pow(random(), 0.8)
      const angle = random() * Math.PI * 2
      const radius = 7 * Math.pow(1 - distance / reach, 1.5) + 0.6
      const r = edgeRadius + 2 + distance + radius
      const x = deposit.x + Math.cos(angle) * r
      const z = deposit.z + Math.sin(angle) * r
      if (own.some(m => Math.hypot(m.x - x, m.z - z) < m.radius + radius + 1)) continue
      own.push({x, z, radius, distance, parent})
    }
    micro.push(...own)
  })

  return {small, large, micro}
}

/** A large drop at one moment. */
export interface LargeDropState {
  x: number
  z: number
  /** Base radius (µm; 0 while it is a crystal). */
  radius: number
  /** Height (µm) at its centre. */
  height: number
  /** How far (µm) its secondary-spreading film reaches past its edge. */
  spread: number
  /** Whether it is liquid. */
  wet: boolean
}

/** The drops at one moment. */
export interface DropState {
  /** Whether NaCl deposited before `lastDeliquescence` is liquid. */
  liquid: boolean
  lastDeliquescence: number
  /** Base radius and height (µm) of a small drop per µm of its crystal's edge (they scale with it). */
  smallRadius: number
  smallHeight: number
  /** Size of the microdroplets relative to 90% RH (0 when dry). */
  microScale: number
  large: LargeDropState[]
}

const LARGE_FIELDS = 6

/**
 * The drops through the exposure, sampled every `DROP_STEP` from the clock's humidity: each large drop's volume follows
 * its salt's hygroscopic growth, it spreads at the advancing contact angle, stays pinned while it shrinks until the
 * receding angle, and then lets go; drops whose footprints touch coalesce (mass-weighted centre, salt summed). Above
 * the critical size a drop's secondary-spreading film creeps out with the time it has been wet. Small drops scale with
 * their crystal's edge, so one unit drop stands for all of them. Deterministic per seed, sampled once.
 */
export class DropModel {

  readonly samples: number
  readonly largeCount: number
  private readonly liquid: Uint8Array
  private readonly lastDeliquescence: Float64Array
  private readonly small: Float32Array
  private readonly large: Float32Array

  constructor(clock: RustClock, salt: SaltField) {
    const molality = new Map<number, number>()
    const volume = (grams: number, rh: number) => {
      const key = Math.round(rh * 2000)
      let m = molality.get(key)
      if (m === undefined) {
        m = naclMolality(key / 2000)
        molality.set(key, m)
      }
      const water = grams / NACL_MOLAR_MASS / m * 1e3
      return (grams + water) / (0.99705 + 0.0406 * m - 0.00128 * m * m) * 1e12
    }

    this.samples = Math.ceil(clock.totalExposure / DROP_STEP) + 2
    this.largeCount = Math.min(salt.large.length, MAX_LARGE_DROPS)
    this.liquid = new Uint8Array(this.samples)
    this.lastDeliquescence = new Float64Array(this.samples)
    this.small = new Float32Array(this.samples * 3)
    this.large = new Float32Array(this.samples * this.largeCount * LARGE_FIELDS)

    const drops = salt.large.slice(0, this.largeCount).map(d => ({
      x: d.x, z: d.z, mass: saltCubeMass(d.edge), pinned: 0, wetTime: 0, merged: -1, radius: 0, height: 0,
      reach: SPREAD_REACH * Math.sqrt(restingRadius(d.edge, MICRO_REFERENCE_RH) / 80),
    }))
    let unitPinned = 0
    const unitMass = saltCubeMass(1)
    const referenceVolume = volume(unitMass, MICRO_REFERENCE_RH)

    const pin = (state: {pinned: number}, v: number) => {
      const advancing = capBaseRadius(v, ADVANCING_ANGLE)
      if (advancing > state.pinned) state.pinned = advancing
      let angle = capAngle(v, state.pinned)
      if (angle < RECEDING_ANGLE) {
        state.pinned = capBaseRadius(v, RECEDING_ANGLE)
        angle = RECEDING_ANGLE
      }
      return {radius: state.pinned, height: capHeight(state.pinned, angle)}
    }

    for (let k = 0; k < this.samples; k++) {
      const t = Math.min(k * DROP_STEP, clock.totalExposure)
      const rh = clock.humidityAt(t)
      const liquid = clock.saltLiquid(t)
      this.liquid[k] = liquid ? 1 : 0
      this.lastDeliquescence[k] = clock.lastDeliquescence(t)

      if (liquid) {
        const unit = {pinned: unitPinned}
        const shape = pin(unit, volume(unitMass, rh))
        unitPinned = unit.pinned
        this.small[k * 3] = shape.radius
        this.small[k * 3 + 1] = shape.height
        this.small[k * 3 + 2] = Math.cbrt(volume(unitMass, rh) / referenceVolume)
      }

      for (const drop of drops) {
        if (drop.merged >= 0) continue
        if (liquid) {
          const shape = pin(drop, volume(drop.mass, rh))
          drop.radius = shape.radius
          drop.height = shape.height
          drop.wetTime += DROP_STEP
        } else {
          drop.radius = 0
          drop.height = 0
        }
      }
      for (let i = 0; i < drops.length; i++) {
        const a = drops[i]
        if (a.merged >= 0 || a.radius <= 0) continue
        for (let j = i + 1; j < drops.length; j++) {
          const b = drops[j]
          if (b.merged >= 0 || b.radius <= 0) continue
          if (Math.hypot(a.x - b.x, a.z - b.z) >= a.radius + b.radius) continue
          const [keep, gone] = a.mass >= b.mass ? [a, b] : [b, a]
          const total = keep.mass + gone.mass
          keep.x = (keep.x * keep.mass + gone.x * gone.mass) / total
          keep.z = (keep.z * keep.mass + gone.z * gone.mass) / total
          keep.mass = total
          keep.pinned = Math.max(keep.pinned, gone.pinned)
          keep.wetTime = Math.max(keep.wetTime, gone.wetTime)
          keep.reach = Math.max(keep.reach, gone.reach)
          gone.merged = drops.indexOf(keep)
          gone.radius = 0
          gone.height = 0
        }
      }

      drops.forEach((drop, i) => {
        const survivor = drop.merged >= 0 ? drops[drop.merged] : drop
        const corrodes = survivor.pinned >= CRITICAL_RADIUS
        const spread = corrodes ? survivor.reach * (1 - Math.exp(-survivor.wetTime / SPREAD_TIME)) : 0
        const offset = (k * this.largeCount + i) * LARGE_FIELDS
        this.large[offset] = drop.x
        this.large[offset + 1] = drop.z
        this.large[offset + 2] = drop.radius
        this.large[offset + 3] = drop.height
        this.large[offset + 4] = spread
        this.large[offset + 5] = liquid && survivor.radius > 0 ? 1 : 0
      })
    }
  }

  /** The drops at exposure time `t`, sizes interpolated between samples. */
  stateAt(t: number): DropState {
    const x = Math.min(Math.max(t / DROP_STEP, 0), this.samples - 1)
    const k = Math.min(Math.floor(x), this.samples - 2)
    const w = x - k
    const k1 = w > 0 ? k + 1 : k
    const mix = (a: number, b: number) => a + (b - a) * w
    const both = this.liquid[k] === 1 && this.liquid[k1] === 1
    const large: LargeDropState[] = []
    for (let i = 0; i < this.largeCount; i++) {
      const o0 = (k * this.largeCount + i) * LARGE_FIELDS
      const o1 = (k1 * this.largeCount + i) * LARGE_FIELDS
      const wet = this.large[o0 + 5] === 1 && this.large[o1 + 5] === 1
      large.push({
        x: mix(this.large[o0], this.large[o1]),
        z: mix(this.large[o0 + 1], this.large[o1 + 1]),
        radius: wet ? mix(this.large[o0 + 2], this.large[o1 + 2]) : 0,
        height: wet ? mix(this.large[o0 + 3], this.large[o1 + 3]) : 0,
        spread: mix(this.large[o0 + 4], this.large[o1 + 4]),
        wet,
      })
    }
    return {
      liquid: both,
      lastDeliquescence: this.lastDeliquescence[k],
      smallRadius: both ? mix(this.small[k * 3], this.small[k1 * 3]) : 0,
      smallHeight: both ? mix(this.small[k * 3 + 1], this.small[k1 * 3 + 1]) : 0,
      microScale: both ? mix(this.small[k * 3 + 2], this.small[k1 * 3 + 2]) : 0,
      large,
    }
  }
}
