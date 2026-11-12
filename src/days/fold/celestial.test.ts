import { describe, it, expect } from 'vitest'
import { Color, MathUtils, Matrix3, Vector3 } from 'three/webgpu'
import {
  EQUATORIAL_TO_GALACTIC, GALACTIC_TO_EQUATORIAL, OBSERVER_LATITUDE, SUN_ECLIPTIC_LONGITUDE, blackbodyColor,
  eclipticDirection, equatorialDirection, equatorialToLocal, localSiderealTime, moonBrightness, rightAscensionOf,
} from './celestial.js'

const degrees = MathUtils.degToRad

describe('celestial', () => {
  it('raises the celestial pole to the latitude in the north', () => {
    const pole = new Vector3(0, 0, 1).applyMatrix3(equatorialToLocal(1.3, OBSERVER_LATITUDE, new Matrix3()))
    expect(Math.asin(pole.y)).toBeCloseTo(OBSERVER_LATITUDE, 6)
    expect(pole.x).toBeCloseTo(0, 6)
    expect(pole.z).toBeLessThan(0)
  })

  it('culminates a star in the south when its right ascension is the sidereal time', () => {
    const siderealTime = degrees(250)
    const star = equatorialDirection(siderealTime, degrees(-20), new Vector3()).applyMatrix3(equatorialToLocal(siderealTime, OBSERVER_LATITUDE, new Matrix3()))
    expect(star.x).toBeCloseTo(0, 6)
    expect(star.z).toBeGreaterThan(0)
    expect(Math.asin(star.y)).toBeCloseTo(degrees(90) - OBSERVER_LATITUDE - degrees(20), 6)
  })

  it('rises stars in the east', () => {
    const siderealTime = 0.4
    const rising = equatorialDirection(siderealTime + Math.PI / 2, 0, new Vector3()).applyMatrix3(equatorialToLocal(siderealTime, OBSERVER_LATITUDE, new Matrix3()))
    expect(rising.x).toBeCloseTo(1, 6)
    expect(rising.y).toBeCloseTo(0, 6)
  })

  it('puts the sun on the meridian at noon and below the horizon at midnight', () => {
    const sun = eclipticDirection(SUN_ECLIPTIC_LONGITUDE, new Vector3())
    const local = (hours: number) => sun.clone().applyMatrix3(equatorialToLocal(localSiderealTime(hours, rightAscensionOf(sun)), OBSERVER_LATITUDE, new Matrix3()))
    expect(local(12).x).toBeCloseTo(0, 6)
    expect(local(12).y).toBeGreaterThan(0.8)
    expect(local(0).y).toBeLessThan(-0.3)
    expect(local(9).x).toBeGreaterThan(0)
  })

  it('lifts a point off the ecliptic by its latitude', () => {
    const onEcliptic = eclipticDirection(2.1, new Vector3())
    const lifted = eclipticDirection(2.1, new Vector3(), degrees(5))
    expect(onEcliptic.angleTo(lifted)).toBeCloseTo(degrees(5), 9)
    expect(lifted.length()).toBeCloseTo(1, 9)
  })

  it('places the galactic center in Sagittarius', () => {
    const center = new Vector3(1, 0, 0).applyMatrix3(GALACTIC_TO_EQUATORIAL)
    expect(MathUtils.radToDeg(rightAscensionOf(center)) + 360).toBeCloseTo(266.4, 0)
    expect(MathUtils.radToDeg(Math.asin(center.z))).toBeCloseTo(-28.9, 0)
    expect(center.clone().applyMatrix3(EQUATORIAL_TO_GALACTIC).x).toBeCloseTo(1, 6)
  })

  it('brightens the moon from new to full', () => {
    expect(moonBrightness(0.5)).toBeCloseTo(1, 6)
    expect(moonBrightness(0.25)).toBeCloseTo(moonBrightness(0.75), 6)
    expect(moonBrightness(0.25)).toBeLessThan(0.15)
    expect(moonBrightness(0.02)).toBeLessThan(0.001)
  })

  it('colors black bodies from red to blue at unit luminance', () => {
    const cool = blackbodyColor(3000, new Color())
    const daylight = blackbodyColor(6500, new Color())
    const hot = blackbodyColor(20000, new Color())
    expect(cool.r).toBeGreaterThan(cool.b)
    expect(hot.b).toBeGreaterThan(hot.r)
    expect(daylight.r).toBeCloseTo(daylight.b, 1)
    expect(0.2126 * daylight.r + 0.7152 * daylight.g + 0.0722 * daylight.b).toBeCloseTo(1, 6)
  })
})
