import { describe, it, expect } from 'vitest'
import { MathUtils, Vector3 } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { FULL_MOON_LUX, SUN_LUX } from './celestial.js'
import { SUN_INTENSITY, SkyRadianceMap, createSkyUniforms, skyRadiance } from './FoldSky.js'

/** A sky with the sun at `degrees` (due south) and the moon at `moonDegrees` (due north), full. */
function skyAt(degrees: number, moonDegrees = -30) {
  const sky = createSkyUniforms(uniform(0))
  const altitude = MathUtils.degToRad(degrees)
  sky.sunDirection.value.set(0, Math.sin(altitude), Math.cos(altitude))
  const moon = MathUtils.degToRad(moonDegrees)
  sky.moonDirection.value.set(0, Math.sin(moon), -Math.cos(moon))
  sky.moonLight.value = FULL_MOON_LUX / SUN_LUX
  return sky
}

/** The sky's light on level ground in lux. */
function skyLux(degrees: number, moonDegrees = -30) {
  const map = new SkyRadianceMap()
  map.update(skyAt(degrees, moonDegrees))
  map.dispose()
  return map.irradiance * SUN_LUX / SUN_INTENSITY
}

describe('SkyRadianceMap', () => {
  it('sends down a clear midday sky of some ten thousand lux', () => {
    expect(skyLux(70)).toBeGreaterThan(5000)
    expect(skyLux(70)).toBeLessThan(60000)
  })

  it('dims through sunset and twilight down to the night glow', () => {
    for (let degrees = -18; degrees < 70; degrees += 2) expect(skyLux(degrees + 2)).toBeGreaterThan(skyLux(degrees))
    expect(skyLux(0)).toBeLessThan(skyLux(30) / 5)
    expect(skyLux(-6)).toBeLessThan(skyLux(0) / 20)
    expect(skyLux(-30)).toBeGreaterThan(0)
    expect(skyLux(-30)).toBeLessThan(0.01)
  })

  it('brightens the night sky under a high full moon', () => {
    expect(skyLux(-30, 50)).toBeGreaterThan(skyLux(-30) * 3)
  })

  it('draws a blue daylit zenith and a warm glow over the setting sun', () => {
    const noon = skyRadiance(skyAt(60), new Vector3(0, 1, 0))
    expect(noon[2]).toBeGreaterThan(noon[0])
    const dusk = skyAt(-3)
    const sunward = skyRadiance(dusk, new Vector3(0, 0.05, 1).normalize())
    expect(sunward[0]).toBeGreaterThan(sunward[2])
  })
})
