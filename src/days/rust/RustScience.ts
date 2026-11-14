/**
 * Physical constants and formulas for Rust: iron and its corrosion products, the Fe(II) oxygenation rate, oxygen through
 * an electrolyte film, and the hygroscopic NaCl drop. SI unless a name says otherwise; lengths named `Um` are in µm.
 * Sources are in `Codevember.plan.md` (§ 11, Research).
 */

export const FARADAY = 96485.33212
export const SECONDS_PER_DAY = 86400

export const IRON_MOLAR_MASS = 55.845
export const IRON_DENSITY = 7.874
/** cm³ of iron per mol (7.09). */
export const IRON_MOLAR_VOLUME = IRON_MOLAR_MASS / IRON_DENSITY

/**
 * µm of iron dissolved per second by 1 A/m² of anodic current (Fe → Fe²⁺ + 2e⁻): 3.7e-5, i.e. 1 A/m² ≡ 1.16 mm a year.
 */
export const IRON_LOSS_RATE = IRON_MOLAR_VOLUME * 1e-6 / (2 * FARADAY) * 1e6

/**
 * The bake keeps dissolved species as amounts per area in `M·µm` (a concentration in mol/L times the film's thickness
 * in µm, which is 1e-3 mol/m²) and rust as the µm of iron it holds. This is the µm of iron in 1 M·µm of iron (7.09e-3).
 */
export const IRON_UM_PER_MOLAR_UM = 1e-3 * IRON_MOLAR_VOLUME

/** M·µm/s of Fe²⁺ released by 1 A/m² of anodic current (two electrons per iron). */
export const FERROUS_PER_ANODIC = 1e3 / (2 * FARADAY)
/** M·µm/s of alkalinity (OH⁻) made by 1 A/m² of cathodic current (one per electron). */
export const ALKALINITY_PER_CATHODIC = 1e3 / FARADAY
/** µm of iron per second reduced from Fe(III) to Fe(II) in rust by 1 A/m² (one electron per iron, Stratmann). */
export const RUST_REDUCTION_RATE = IRON_MOLAR_VOLUME * 1e-6 / FARADAY * 1e6

/** µm of iron lost in `seconds` at `current` A/m². */
export function ironLoss(current: number, seconds: number) {
  return current * seconds * IRON_LOSS_RATE
}

/** A corrosion product: what it weighs and how dense it is, per formula unit, and how porous it grows. */
export interface RustPhase {
  name: string
  formula: string
  /** g/mol per formula unit. */
  molarMass: number
  /** g/cm³. */
  density: number
  /** Iron atoms per formula unit. */
  iron: number
  /** Share of a layer of it that is pore. */
  porosity: number
}

/** The phases in the order the bake stores them: `solidA = (GR, FH, LP, GT)`, `solidB = (AK, MG, Fe(II), loss)`. */
export const RUST_PHASES = {
  greenRust: {name: 'green rust', formula: 'Fe(II)3Fe(III)(OH)8Cl·2H2O', molarMass: 430.9, density: 2.8, iron: 4, porosity: 0.5},
  ferrihydrite: {name: 'ferrihydrite', formula: 'Fe5HO8·4H2O', molarMass: 480.3, density: 3.8, iron: 5, porosity: 0.4},
  lepidocrocite: {name: 'lepidocrocite', formula: 'γ-FeOOH', molarMass: 88.85, density: 4.09, iron: 1, porosity: 0.5},
  goethite: {name: 'goethite', formula: 'α-FeOOH', molarMass: 88.85, density: 4.26, iron: 1, porosity: 0.3},
  akaganeite: {name: 'akaganeite', formula: 'β-FeO(OH,Cl)', molarMass: 89.5, density: 3.56, iron: 1, porosity: 0.5},
  magnetite: {name: 'magnetite', formula: 'Fe3O4', molarMass: 231.53, density: 5.18, iron: 3, porosity: 0.15},
} satisfies Record<string, RustPhase>

export type RustPhaseName = keyof typeof RUST_PHASES

/**
 * Volume of a phase per volume of the iron in it (the Pilling–Bedworth ratio for iron): magnetite 2.10, goethite 2.94,
 * lepidocrocite 3.06, akaganeite and ferrihydrite ~3.5. Porosity comes on top.
 */
export function volumeRatio(phase: RustPhase) {
  return phase.molarMass / phase.density / phase.iron / IRON_MOLAR_VOLUME
}

/** µm of layer grown per µm of iron turned into this phase, pores included. */
export function layerPerIron(phase: RustPhase) {
  return volumeRatio(phase) / (1 - phase.porosity)
}

/** Stumm & Lee (1961): `-d[Fe²⁺]/dt = k [OH⁻]² p(O₂) [Fe²⁺]`, k = 8e13 M⁻² atm⁻¹ min⁻¹ at 20 °C, here per second. */
export const STUMM_LEE_K = 8e13 / 60

/** First-order rate (1/s) at which dissolved Fe(II) oxygenates at `pH` under `oxygen` atm of O₂. */
export function ferrousOxidationRate(pH: number, oxygen = 0.21) {
  const hydroxide = 10 ** (pH - 14)
  return STUMM_LEE_K * hydroxide * hydroxide * oxygen
}

/** Seconds for half the dissolved Fe(II) to oxygenate: 4 min at pH 7, 7 h at pH 6, 2.5 s at pH 8 (air). */
export function ferrousHalfLife(pH: number, oxygen = 0.21) {
  return Math.LN2 / ferrousOxidationRate(pH, oxygen)
}

/** Solubility product of Fe(OH)₂ (M³). */
export const FERROUS_HYDROXIDE_KSP = 4.87e-17
/** First hydrolysis constant of Fe²⁺ (Fe²⁺ + H₂O ⇌ FeOH⁺ + H⁺): what acidifies a pit to pH ~5. */
export const FERROUS_HYDROLYSIS = 10 ** -9.5

/** The air's CO₂ in a film: [HCO₃⁻] = c₁/[H⁺], [CO₃²⁻] = c₂/[H⁺]² (M², M³; K_H·pCO₂ at 420 ppm, K₁ and K₂ at 25 °C). */
export const CARBONATE_HCO3 = 10 ** -1.47 * 4.2e-4 * 10 ** -6.35
export const CARBONATE_CO3 = CARBONATE_HCO3 * 10 ** -10.33

/**
 * pH of a film in air with `alkalinity` (M of acid it can neutralize: OH⁻ and carbonate less H⁺, from the electrode
 * reactions; taking up CO₂ leaves it as it is) and `ferrous` (M of Fe²⁺, whose hydrolysis adds acid), its carbonate in
 * equilibrium with the air: pure water sits at 5.6, bicarbonate near 8, an alkali film buffers at 10–11.
 */
export function filmPH(alkalinity: number, ferrous: number) {
  const effective = alkalinity - Math.sqrt(FERROUS_HYDROLYSIS * Math.max(ferrous, 0))
  const c1 = CARBONATE_HCO3 + 1e-14
  // HCO₃⁻ and CO₃²⁻ carry it: 2c₂x² + c₁x = A for x = 1/[H⁺]
  if (effective > 1e-4) return Math.log10(2 * effective / (c1 + Math.sqrt(c1 * c1 + 8 * CARBONATE_CO3 * effective)))
  // HCO₃⁻ and OH⁻ against H⁺: y − c₁/y = A for y = c₁/[H⁺]
  return Math.log10(0.5 * (effective + Math.sqrt(effective * effective + 4 * c1)) / c1)
}

/** O₂ diffusivity in water (m²/s) and its solubility under air (mol/m³, 25 °C, fresh water). */
export const OXYGEN_DIFFUSIVITY = 2e-9
export const OXYGEN_SOLUBILITY = 0.25
/** Sechenov salting-out: log10 of the O₂ solubility drops by this per M of NaCl. */
export const OXYGEN_SALTING = 0.12

/** O₂ solubility (mol/m³) in a film with `chloride` M of NaCl. */
export function oxygenSolubility(chloride = 0) {
  return OXYGEN_SOLUBILITY * 10 ** (-OXYGEN_SALTING * chloride)
}

/**
 * Cathodic current (A/m²) at which O₂ diffusing through `filmUm` µm of electrolyte runs out: `4FDC/h`, 1.9 mA/cm² at
 * 10 µm, 0.19 at 100 µm.
 */
export function oxygenLimitingCurrent(filmUm: number, chloride = 0) {
  return 4 * FARADAY * OXYGEN_DIFFUSIVITY * oxygenSolubility(chloride) / (filmUm * 1e-6)
}

/** Conductivity (S/m) of NaCl brine of ionic strength ~`molar` M: ~5 S/m like seawater at 0.6 M, ~24 near saturation. */
export function brineConductivity(molar: number) {
  return 8.5 * molar / (1 + 0.15 * molar)
}

export const NACL_MOLAR_MASS = 58.443
export const NACL_DENSITY = 2.165
/** Saturation molality of NaCl at 25 °C (mol/kg). */
export const NACL_SATURATION = 6.144
/** Relative humidity at which an NaCl crystal deliquesces, and at which a drop of it crystallizes again (hysteresis). */
export const DELIQUESCENCE_RH = 0.753
export const EFFLORESCENCE_RH = 0.45
const WATER_MOLAR_MASS = 0.018015

/** Osmotic coefficients of aqueous NaCl at 25 °C (Robinson & Stokes), molality → φ, extended past saturation. */
const OSMOTIC = [
  [0, 1], [0.1, 0.932], [0.2, 0.925], [0.3, 0.922], [0.5, 0.921], [0.7, 0.926], [1, 0.936], [1.5, 0.959],
  [2, 0.983], [2.5, 1.013], [3, 1.045], [3.5, 1.08], [4, 1.116], [4.5, 1.153], [5, 1.192], [5.5, 1.231],
  [6, 1.271], [14, 1.9],
] as const

function osmoticCoefficient(molality: number) {
  for (let i = 1; i < OSMOTIC.length; i++) {
    const [m1, p1] = OSMOTIC[i]
    if (molality <= m1 || i === OSMOTIC.length - 1) {
      const [m0, p0] = OSMOTIC[i - 1]
      return p0 + (p1 - p0) * (molality - m0) / (m1 - m0)
    }
  }
  return 1
}

/** Water activity of NaCl solution at `molality` (mol/kg): 0.967 at 1, 0.753 at saturation. */
export function naclWaterActivity(molality: number) {
  return Math.exp(-2 * molality * osmoticCoefficient(molality) * WATER_MOLAR_MASS)
}

/**
 * Molality (mol/kg) of an NaCl drop in equilibrium with relative humidity `rh` (its water activity), by bisection.
 * Below 75.3% the drop is supersaturated (it stays liquid until 45%); capped at 14 mol/kg.
 */
export function naclMolality(rh: number) {
  const target = Math.min(Math.max(rh, 0.3), 0.995)
  let lo = 0
  let hi = 14
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi)
    if (naclWaterActivity(mid) > target) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

/** Density (g/cm³) of NaCl solution at `molality`: 1.037 at 1 mol/kg, 1.195 at 6. */
export function brineDensity(molality: number) {
  return 0.99705 + 0.0406 * molality - 0.00128 * molality * molality
}

/** Molar concentration (mol/L) of NaCl solution at `molality`. */
export function brineMolarity(molality: number) {
  const density = brineDensity(molality)
  return molality * density / (1 + molality * NACL_MOLAR_MASS * 1e-3)
}

/** Volume (µm³) of a drop holding `saltGrams` g of NaCl at relative humidity `rh`. */
export function dropVolume(saltGrams: number, rh: number) {
  const molality = naclMolality(rh)
  const water = saltGrams / NACL_MOLAR_MASS / molality * 1e3
  return (saltGrams + water) / brineDensity(molality) * 1e12
}

/** Mass (g) of an NaCl cube of edge `edgeUm` µm. */
export function saltCubeMass(edgeUm: number) {
  return NACL_DENSITY * edgeUm * edgeUm * edgeUm * 1e-12
}

/** A spherical cap's volume per cubed base radius at contact angle `angle` (rad). */
export function capVolumeFactor(angle: number) {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return Math.PI * (2 - 3 * c + c * c * c) / (3 * s * s * s)
}

/** Base radius of a spherical cap of `volume` at contact `angle`. */
export function capBaseRadius(volume: number, angle: number) {
  return Math.cbrt(volume / capVolumeFactor(angle))
}

/** Height of a spherical cap of base `radius` at contact `angle`. */
export function capHeight(radius: number, angle: number) {
  return radius * Math.tan(angle / 2)
}

/** Contact angle of a spherical cap of `volume` pinned at base `radius`, by bisection (0–π/2). */
export function capAngle(volume: number, radius: number) {
  if (volume <= 0 || radius <= 0) return 0
  let lo = 1e-4
  let hi = Math.PI / 2
  for (let i = 0; i < 50; i++) {
    const mid = 0.5 * (lo + hi)
    if (capVolumeFactor(mid) * radius * radius * radius < volume) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

/** A seeded uniform random number generator (mulberry32). */
export function createRandom(seed: number) {
  let state = (seed * 2654435761) >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A standard normal deviate from `random` (Box–Muller). */
export function gaussian(random: () => number) {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())
}
