import { Color, MathUtils, Matrix3, Vector3 } from 'three/webgpu'

/**
 * The sky over North Coyote Buttes (36.99° N) in mid-August, when the Milky Way core is up in the evening. Frames:
 * equatorial (J2000: x toward the vernal equinox, y toward 6h right ascension, z toward the north celestial pole),
 * galactic (x toward the galactic center, z toward the north galactic pole) and local (three's: x east, y up, z south).
 */
export const OBSERVER_LATITUDE = MathUtils.degToRad(36.99)

/** The sun's ecliptic longitude in mid-August. */
export const SUN_ECLIPTIC_LONGITUDE = MathUtils.degToRad(143)

/** The moon's ecliptic latitude (its orbit is inclined 5°), so a full moon is not eclipsed. */
export const MOON_ECLIPTIC_LATITUDE = MathUtils.degToRad(3)

const OBLIQUITY = MathUtils.degToRad(23.44)

/** Equatorial to galactic (IAU 1958 pole and origin, in J2000). */
export const EQUATORIAL_TO_GALACTIC = new Matrix3().set(
  -0.0548755604, -0.8734370902, -0.4838350155,
  0.4941094279, -0.4448296300, 0.7469822445,
  -0.8676661490, -0.1980763734, 0.4559837762,
)

export const GALACTIC_TO_EQUATORIAL = EQUATORIAL_TO_GALACTIC.clone().transpose()

export function equatorialDirection(rightAscension: number, declination: number, target: Vector3) {
  const cosDeclination = Math.cos(declination)
  return target.set(cosDeclination * Math.cos(rightAscension), cosDeclination * Math.sin(rightAscension), Math.sin(declination))
}

/** A point at an ecliptic longitude (and latitude), as an equatorial direction. */
export function eclipticDirection(longitude: number, target: Vector3, latitude = 0) {
  const x = Math.cos(latitude) * Math.cos(longitude)
  const y = Math.cos(latitude) * Math.sin(longitude)
  const z = Math.sin(latitude)
  return target.set(x, y * Math.cos(OBLIQUITY) - z * Math.sin(OBLIQUITY), y * Math.sin(OBLIQUITY) + z * Math.cos(OBLIQUITY))
}

/** Right ascension of an equatorial direction, in radians. */
export function rightAscensionOf(direction: Vector3) {
  return Math.atan2(direction.y, direction.x)
}

/**
 * Equatorial to local at a local sidereal time (radians): turns the sky about the celestial pole, then tilts the pole
 * up to the observer's latitude in the north (-z).
 */
export function equatorialToLocal(localSiderealTime: number, latitude: number, target: Matrix3) {
  const cosTime = Math.cos(localSiderealTime)
  const sinTime = Math.sin(localSiderealTime)
  const cosLatitude = Math.cos(latitude)
  const sinLatitude = Math.sin(latitude)
  return target.set(
    -sinTime, cosTime, 0,
    cosLatitude * cosTime, cosLatitude * sinTime, sinLatitude,
    sinLatitude * cosTime, sinLatitude * sinTime, -cosLatitude,
  )
}

/** Local sidereal time (radians) at a local solar time in hours, from the sun's right ascension. */
export function localSiderealTime(solarHours: number, sunRightAscension: number) {
  return sunRightAscension + (solarHours - 12) / 24 * Math.PI * 2
}

/** Illuminance in lux of a star of visual magnitude `magnitude` above the atmosphere. */
export function magnitudeToLux(magnitude: number) {
  return Math.pow(10, -0.4 * (magnitude + 13.98))
}

/**
 * Linear sRGB chromaticity of a black body at `kelvin` (Kim et al. Planckian locus fit), scaled to unit luminance.
 */
export function blackbodyColor(kelvin: number, target: Color) {
  const t = MathUtils.clamp(kelvin, 1667, 25000)
  const t2 = t * t
  const t3 = t2 * t
  const x = t <= 4000
    ? -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.179910
    : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.240390
  const x2 = x * x
  const x3 = x2 * x
  const y = t <= 2222
    ? -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683
    : t <= 4000
      ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
      : 3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483
  const X = x / y
  const Z = (1 - x - y) / y
  const r = 3.2404542 * X - 1.5371385 - 0.4985314 * Z
  const g = -0.9692660 * X + 1.8760108 + 0.0415560 * Z
  const b = 0.0556434 * X - 0.2040259 + 1.0572252 * Z
  target.setRGB(Math.max(r, 0), Math.max(g, 0), Math.max(b, 0))
  const luminance = 0.2126 * target.r + 0.7152 * target.g + 0.0722 * target.b
  return target.multiplyScalar(1 / luminance)
}

/** Relative air mass toward an altitude (radians) above the horizon (Kasten & Young). */
export function airMass(altitude: number) {
  const degrees = Math.max(MathUtils.radToDeg(altitude), -0.5)
  return 1 / (Math.sin(Math.max(altitude, -0.0087)) + 0.50572 * Math.pow(degrees + 6.07995, -1.6364))
}

/** Full-moon illuminance overhead, in lux. */
export const FULL_MOON_LUX = 0.27

/** Direct sun overhead through a clear atmosphere, in lux. */
export const SUN_LUX = 100000

/** Fraction of full-moon brightness at a phase (0 new, 0.5 full): lit fraction with the opposition surge. */
export function moonBrightness(phase: number) {
  const phaseAngle = Math.abs(0.5 - (((phase % 1) + 1) % 1)) * Math.PI * 2 // 0 at full, π at new
  return Math.pow(10, -0.4 * (0.026 * MathUtils.radToDeg(phaseAngle) + 4e-9 * Math.pow(MathUtils.radToDeg(phaseAngle), 4)))
}

/** A seeded PRNG (mulberry32) returning floats in [0, 1). */
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
