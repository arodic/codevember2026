import {
  BackSide, BoxGeometry, DataTexture, FloatType, LinearFilter, MathUtils, Matrix3, Mesh, Node, NodeMaterial, RGBAFormat,
  RepeatWrapping, UniformNode, Vector3,
} from 'three/webgpu'
import {
  Fn, If, abs, acos, add, atan, cameraPosition, clamp, cos, cross, dot, exp, float, floor, fract, length, max, min, mix,
  modelViewProjection, mx_fractal_noise_float, mx_noise_float, normalize, positionWorld, pow, saturate, select,
  smoothstep, sqrt, sub, uniform, vec2, vec3, vec4,
} from 'three/tsl'

/** Sun irradiance overhead, in light units; the sky's radiance is in the same units. */
export const SUN_INTENSITY = 30

/** Angular radius of the moon's disc (drawn a little larger than its 0.26°). */
export const MOON_RADIUS = 0.0052

/** Height of the cloud deck above the terrain, for the shadows it casts. */
export const CLOUD_HEIGHT = 70

const CLOUD_SCALE = 0.0002
/** Drift of the deck per second of its clock (`cloudTime`), and with it how fast its clouds billow: a time-lapse's racing sky. */
const CLOUD_SPEED = 0.0004
/** The deck's elevation term from three's `SkyMesh` (`cloudElevation` 0.5). */
const CLOUD_ELEVATION = 0.55
/**
 * How far across the deck (in its noise's units, per unit of the light's cotangent) light travels from the top of a
 * cloud down to its base: a cumulus about as tall as a quarter of its height above the ground.
 */
const LIGHT_REACH = 0.09
/** Where along that path (fractions) the light is sampled, and how much each sample counts. */
const LIGHT_STEPS = [[0.12, 0.2], [0.3, 0.25], [0.55, 0.25], [0.85, 0.3]] as const
/**
 * Elevation sines of the key light over which the clouds' shading toward it fades in: their shadows on the land, and
 * the light marched through the deck. Toward a grazing light both race across with every step of it (the shadows'
 * offset goes as the cotangent), a sweep too fast to read at each sunrise and sunset.
 */
const CLOUD_SHADOW_FADE = [0.06, 0.3] as const
/** Opacity of the deck's shadows at their darkest. */
const CLOUD_SHADOW = 0.85
/** Albedo of cloud droplets. */
const CLOUD_ALBEDO = 0.9

/**
 * The uniforms the sky, the stars and the terrain share. Light is in pre-exposed units: everything the scene emits
 * or reflects is scaled by `preExposure`, so a moonless night stays within half-float range.
 */
export function createSkyUniforms(time: UniformNode<'float', number>) {
  return {
    time,
    /** The clouds' own clock: playback time scaled by how fast they race (advanced by the document, so it never jumps). */
    cloudTime: uniform(0),
    sunDirection: uniform(new Vector3(0, 1, 0)),
    moonDirection: uniform(new Vector3(0, -1, 0)),
    /** Moon illuminance relative to the sun's, with the phase. */
    moonLight: uniform(0),
    preExposure: uniform(1),
    turbidity: uniform(2.5),
    rayleigh: uniform(1.2),
    mieCoefficient: uniform(0.004),
    mieDirectionalG: uniform(0.8),
    cloudCoverage: uniform(0.3),
    cloudDensity: uniform(0.5),
    /** The sky's light as a uniform radiance (its irradiance on level ground over π, not pre-exposed), for the clouds. */
    ambient: uniform(new Vector3()),
    /**
     * Sunlight and moonlight at the cloud deck, facing them (light units, not pre-exposed): reddened through the air,
     * and seen a little longer than from the ground.
     */
    sunIrradiance: uniform(new Vector3()),
    moonIrradiance: uniform(new Vector3()),
    /** Equatorial (J2000) to local: the turning sky. */
    celestialFrame: uniform(new Matrix3()),
    /** Local to galactic. */
    galacticFrame: uniform(new Matrix3()),
    milkyWay: uniform(1),
  }
}

export type SkyUniforms = ReturnType<typeof createSkyUniforms>

type Vec2 = Node<'vec2'>
type Vec3 = Node<'vec3'>
type Float = Node<'float'>

/** Gradient at a lattice corner; a sinless hash, so every GPU draws the same clouds (from three's `SkyMesh`). */
const gradient = Fn(([i]: [Vec2]) => {
  const q = fract(vec3(i.x, i.y, i.x).mul(vec3(0.1031, 0.1030, 0.0973)))
  const p = q.add(dot(q, q.yzx.add(33.33)))
  return fract(p.xx.add(p.yz).mul(p.zy)).mul(2.0).sub(1.0)
}, {i: 'vec2', return: 'vec2'})

const gradientNoise = Fn(([p]: [Vec2]) => {
  const i = floor(p)
  const f = fract(p)
  const u = f.mul(f).mul(f).mul(f.mul(f.mul(6.0).sub(15.0)).add(10.0))
  const a = dot(gradient(i), f)
  const b = dot(gradient(i.add(vec2(1.0, 0.0))), f.sub(vec2(1.0, 0.0)))
  const c = dot(gradient(i.add(vec2(0.0, 1.0))), f.sub(vec2(0.0, 1.0)))
  const d = dot(gradient(i.add(vec2(1.0, 1.0))), f.sub(vec2(1.0, 1.0)))
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y).mul(1.6)
}, {p: 'vec2', return: 'float'})

/**
 * Fractal gradient noise, each octave turned (so the lattice never shows) and drifting (so the clouds billow instead
 * of scrolling as a rigid stamp); `billow` sums absolute values, lobes meeting in creases like a cumulus' cauliflower.
 * `frequency` is the first octave's per unit of `position`; octaves fade out as they shrink toward `footprint` (a
 * pixel, in those units) instead of aliasing into glitter toward the horizon.
 */
function cloudFbm(position: Vec2, frequency: number, drift: Vec2, octaves: number, footprint: Float, billow = false): Float {
  const key = `${frequency}/${octaves}/${billow}`
  let fbm = FBM_FUNCTIONS.get(key)
  if (!fbm) {
    // a shader function per kind, each octave in a variable: inlined, the octaves would nest the expression
    fbm = Fn(([position, drift, footprint]: [Vec2, Vec2, Float]) => {
      const p = position.mul(frequency).toVar()
      const sum = float(0.0).toVar()
      let amplitude = 0.5
      let octaveFrequency = frequency
      for (let i = 0; i < octaves; i++) {
        const n = gradientNoise(p)
        const resolved = sub(1.0, smoothstep(0.12, 0.35, footprint.mul(octaveFrequency)))
        sum.addAssign((billow ? abs(n) : n).mul(resolved.mul(amplitude)))
        amplitude *= 0.5
        octaveFrequency *= 2.03
        p.assign(vec2(p.x.mul(0.8).sub(p.y.mul(0.6)), p.x.mul(0.6).add(p.y.mul(0.8))).mul(2.03).add(drift))
      }
      return sum
    }, {position: 'vec2', drift: 'vec2', footprint: 'float', return: 'float'}) as unknown as FbmFunction
    FBM_FUNCTIONS.set(key, fbm)
  }
  return fbm(position, drift, footprint)
}

type FbmFunction = (position: Vec2, drift: Vec2, footprint: Float) => Float
const FBM_FUNCTIONS = new Map<string, FbmFunction>()

/** The size of a pixel on the deck, in its noise's units, looking at elevation sine `sine` (about a milliradian a pixel). */
function cloudFootprint(sine: Float): Float {
  return float(0.364 * 0.0011).div(sine.mul(sine).max(1e-4))
}

/** Where a direction from the terrain meets the cloud deck, in deck coordinates. */
export function cloudPlaneUV(sky: SkyUniforms, direction: Vec3): Vec2 {
  return direction.xz.div(direction.y.max(0.001).mul(CLOUD_ELEVATION)).mul(CLOUD_SCALE).add(sky.cloudTime.mul(CLOUD_SPEED))
}

/** Where a vertical ray from a terrain point meets the deck, offset toward the light along `direction`. */
export function cloudShadowUV(sky: SkyUniforms, position: Vec3, direction: Vec3): Vec2 {
  const hit = position.xz.add(direction.xz.div(direction.y.max(0.05)).mul(float(CLOUD_HEIGHT).sub(position.y)))
  return hit.div(CLOUD_HEIGHT * CLOUD_ELEVATION).mul(CLOUD_SCALE).add(sky.cloudTime.mul(CLOUD_SPEED))
}

function cloudDrift(sky: SkyUniforms) {
  return vec2(sky.cloudTime.mul(CLOUD_SPEED * 300))
}

/**
 * The deck's shape at a point, 0 clear to 1 a cumulus core: lumps about a cloud across, warped out of round, carved by
 * the coverage (which a slow weather field moves about). Shadows and the stars see the clouds this coarse.
 */
function cloudShape(sky: SkyUniforms, uv: Vec2, footprint: Float = float(0.0)): Float {
  return CLOUD_SHAPE(uv, footprint, sky.cloudCoverage, cloudDrift(sky))
}

type ShapeFunction = (uv: Vec2, footprint: Float, coverage: Float, drift: Vec2) => Float

/** The shape as one shader function; the uniforms come in as arguments (a function cannot bind them in every shader). */
const CLOUD_SHAPE = Fn(([uv, footprint, cloudCoverage, drift]: [Vec2, Float, Float, Vec2]) => {
  const p = uv.mul(1000.0).toVar()
  const weather = gradientNoise(p.mul(0.3).add(vec2(7.3, 1.9))).mul(0.5).add(0.5)
  const coverage = clamp(cloudCoverage.add(weather.sub(0.5).mul(0.45)), 0.0, 1.0).toVar()
  const warp = vec2(gradientNoise(p.mul(1.1).add(vec2(3.1, 9.4))), gradientNoise(p.mul(1.1).add(vec2(8.7, 2.2)))).mul(0.22)
  const lumps = cloudFbm(p.add(warp.div(1.9)), 1.9, drift, 4, footprint).mul(1.6).add(0.5)
  return saturate(lumps.sub(sub(1.0, coverage)).div(coverage.max(0.05)).mul(2.6))
}, {uv: 'vec2', footprint: 'float', cloudCoverage: 'float', drift: 'vec2', return: 'float'}) as unknown as ShapeFunction

/** Cauliflower billows at a point, a tenth of a cloud across. */
function cloudBillows(sky: SkyUniforms, uv: Vec2, footprint: Float): Float {
  return cloudFbm(uv.mul(1000.0), 11.0, cloudDrift(sky).mul(1.6), 3, footprint, true)
}

/** The density the billows leave of a shape: they eat into the thin edges and texture the cores. */
function cloudErode(shape: Float, billows: Float): Float {
  return saturate(shape.sub(billows.mul(0.9).mul(sub(1.0, shape).mul(0.7).add(0.15))))
}

/** Optical depth through the deck at a density, along a ray at elevation sine `sine` (the slab's slant): cores are taller. */
function cloudDepth(sky: SkyUniforms, density: Float, sine: Float): Float {
  const slant = pow(min(float(1.0).div(sine.max(0.01)), 8.0), 0.65)
  return density.mul(density.mul(0.65).add(0.35)).mul(sky.cloudDensity).mul(14.0).mul(slant)
}

/** Opacity of the deck at a point along a ray at elevation sine `sine` (1 straight up), coarse: for the shadows it casts. */
function cloudOpacity(sky: SkyUniforms, uv: Vec2, sine: Float = float(1.0)): Float {
  return sub(1.0, exp(cloudDepth(sky, cloudShape(sky, uv), sine).negate())).mul(smoothstep(0.0, 0.02, sky.cloudCoverage))
}

/** Light the deck lets through to a point of the land toward the key light `key`, its shadows faded out as `key` grazes. */
export function cloudShadow(sky: SkyUniforms, position: Vec3, key: Vec3): Float {
  const strength = smoothstep(CLOUD_SHADOW_FADE[0], CLOUD_SHADOW_FADE[1], key.y).mul(CLOUD_SHADOW)
  return sub(1.0, cloudOpacity(sky, cloudShadowUV(sky, position, key), key.y).mul(strength))
}

/**
 * The deck along a ray from the ground in `direction`: its shape and density (with the billows) where the ray meets it,
 * and its opacity. Low over the land the ray passes the sides of many clouds, so toward the horizon they close up (more
 * of the deck covered) into a bank.
 */
function cloudAlong(sky: SkyUniforms, direction: Vec3) {
  const uv = cloudPlaneUV(sky, direction)
  const footprint = cloudFootprint(direction.y)
  const coverage = sky.cloudCoverage.add(sub(1.0, sky.cloudCoverage).mul(sky.cloudCoverage.min(0.3)).mul(smoothstep(0.45, 0.05, direction.y)))
  const shape = CLOUD_SHAPE(uv, footprint, coverage, cloudDrift(sky))
  const density = cloudErode(shape, cloudBillows(sky, uv, footprint))
  return {uv, footprint, shape, density, opacity: sub(1.0, exp(cloudDepth(sky, density, direction.y).negate()))}
}

/** Opacity of the deck toward a direction in the sky, as the dome draws it (for the stars and the meteors). */
export function cloudOpacityToward(sky: SkyUniforms, direction: Vec3): Float {
  return cloudAlong(sky, direction).opacity.mul(smoothstep(0.0, 0.02, sky.cloudCoverage))
}

/** Henyey-Greenstein phase times 4π (1 for isotropic scattering). */
function henyeyGreenstein(g: number, cosTheta: Float): Float {
  return float(1 - g * g).div(pow(float(1 + g * g).sub(cosTheta.mul(2 * g)), 1.5))
}

/** A cloud's phase: strong forward scattering (the silver lining) with a little back. */
function cloudPhase(cosTheta: Float): Float {
  return mix(henyeyGreenstein(0.65, cosTheta), henyeyGreenstein(-0.25, cosTheta), 0.3).min(6.0)
}

/** Preetham's Rayleigh and Mie coefficients of the primaries and the earth-shadow cutoff (three's `SkyMesh`). */
const TOTAL_RAYLEIGH = [5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5] as const
const MIE_CONST = [1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14] as const
const CUTOFF_ANGLE = 1.6110731556870734

/**
 * The moon's light scatters with less and tighter Mie haze than the sun's (its aureole would otherwise fill the
 * night sky), and the moonlit sky is drawn dimmer than physical, so the stars hold.
 */
const MOON_MIE = 0.15
const MOON_G = 0.96
const MOONLIT_SKY = 0.45
/**
 * Pre-exposed radiance the moon's disc is held under: overexposed against a moonlit landscape it is white whatever
 * its radiance, and the bloom would spread the rest of it into a glow over half the sky.
 */
const MOON_DISC_LIMIT = 300

/**
 * Preetham scattering for one light (the sun, or the moon at the sun's strength), from three's `SkyMesh`; `mie` scales
 * the haze and `g` sets its directionality.
 */
function preetham(sky: SkyUniforms, direction: Vec3, light: Vec3, mie: number | Float = 1, g: Float = sky.mieDirectionalG) {
  const totalRayleigh = vec3(...TOTAL_RAYLEIGH)
  const mieConst = vec3(...MIE_CONST)
  const cutoffAngle = float(CUTOFF_ANGLE)
  const lightE = float(1000.0).mul(max(0.0, sub(1.0, exp(cutoffAngle.sub(acos(clamp(light.y, -1, 1))).div(1.5).negate()))))
  const betaR = totalRayleigh.mul(sky.rayleigh)
  const betaM = float(0.434).mul(float(0.2).mul(sky.turbidity).mul(10E-18)).mul(mieConst).mul(sky.mieCoefficient).mul(mie)
  // a unit vector's y rounds past 1 at the zenith: acos of it is NaN
  const zenithAngle = acos(clamp(direction.y, 0.0, 1.0))
  const inverse = float(1.0).div(cos(zenithAngle).add(float(0.15).mul(pow(float(93.885).sub(zenithAngle.mul(180.0 / Math.PI)), -1.253))))
  const extinction = exp(betaR.mul(inverse.mul(8.4E3)).add(betaM.mul(inverse.mul(1.25E3))).negate())
  const cosTheta = dot(direction, light)
  const rPhase = float(3.0 / (16.0 * Math.PI)).mul(add(1.0, pow(cosTheta.mul(0.5).add(0.5), 2.0)))
  const g2 = pow(g, 2.0)
  const mPhase = float(1.0 / (4.0 * Math.PI)).mul(sub(1.0, g2)).div(pow(sub(1.0, g.mul(2.0).mul(cosTheta)).add(g2), 1.5))
  const ratio = betaR.mul(rPhase).add(betaM.mul(mPhase)).div(betaR.add(betaM))
  const inscatter = pow(lightE.mul(ratio).mul(sub(1.0, extinction)), vec3(1.5)).toVar()
  inscatter.mulAssign(mix(vec3(1.0), pow(lightE.mul(ratio).mul(extinction), vec3(0.5)), clamp(pow(sub(1.0, light.y), 5.0), 0.0, 1.0)))
  return {inscatter: inscatter.mul(0.04), extinction, lightE, cosTheta}
}

/**
 * Twilight once the sun is down, which Preetham's model drops: a sky dimming about 0.43 decades per degree of solar
 * depression, ozone-blue overhead, an orange to red glow over the sunken sun, and the Earth's shadow rising in the
 * antisolar sky under the pink Belt of Venus.
 */
function twilight(direction: Vec3, sun: Vec3) {
  const depression = clamp(sun.y.negate(), 0.0, 1.0).asin().mul(180 / Math.PI)
  const weight = smoothstep(0.02, -0.05, sun.y)
  const zenith = float(0.08).mul(pow(10.0, depression.mul(-0.4)))
  const up = max(direction.y, 0.0)
  const cosAzimuth = dot(normalize(sun.xz.add(vec2(1e-5, 0))), normalize(direction.xz.add(vec2(1e-5, 0))))
  const sunward = pow(cosAzimuth.mul(0.5).add(0.5), 3.0)
  const antisolar = pow(sub(0.5, cosAzimuth.mul(0.5)), 2.0)
  const glowColor = mix(vec3(1.0, 0.55, 0.22), vec3(0.85, 0.22, 0.1), smoothstep(0.0, 10.0, depression))
  const glow = glowColor.mul(sunward).mul(exp(up.negate().div(mix(0.25, 0.07, smoothstep(0.0, 12.0, depression))))).mul(3.0)
  const beltHeight = depression.mul(0.012).add(0.05)
  const belt = vec3(1.0, 0.5, 0.55).mul(antisolar).mul(exp(pow(up.sub(beltHeight).div(0.05), 2.0).negate())).mul(1.6)
  const earthShadow = sub(1.0, antisolar.mul(sub(1.0, smoothstep(0.0, beltHeight, up))).mul(0.6))
  const blue = vec3(0.22, 0.42, 1.0).mul(sub(1.4, up.mul(0.8)))
  return {color: blue.mul(earthShadow).add(glow).add(belt).mul(zenith).mul(weight), zenith: zenith.mul(weight), glowColor, sunward}
}

/** Dark dust of the galactic plane, densest along the Great Rift from Cygnus to the core. */
export function galacticDust(galactic: Vec3): Float {
  const clumps = mx_fractal_noise_float(galactic.mul(13.0), 5, 2.1, 0.6).mul(0.5).add(0.5)
  const lane = exp(pow(galactic.z.div(0.03).sub(0.4), 2.0).negate())
  const rift = smoothstep(-0.35, 0.5, galactic.x.add(galactic.y.mul(0.6)))
  const disk = exp(abs(galactic.z).div(0.05).negate())
  return lane.mul(rift).mul(smoothstep(0.4, 0.75, clumps)).add(disk.mul(smoothstep(0.55, 0.85, clumps)).mul(0.6))
}

/**
 * Light of the unresolved Milky Way (thin disk, thick disk, bulge), dimmed by its dust, in units of the night sky.
 * At the galactic poles the rotated direction's z rounds past ±1, and asin of it is NaN: the dome's output cap turns a
 * NaN into its brightest value, a pixel the bloom spreads into a flash.
 */
export function milkyWayGlow(galactic: Vec3) {
  const longitude = atan(galactic.y, galactic.x)
  const latitude = clamp(galactic.z, -1.0, 1.0).asin()
  const disk = exp(abs(galactic.z).div(0.1).negate()).mul(add(0.35, exp(abs(longitude).div(1.1).negate()).mul(0.65)))
  const bulge = exp(longitude.mul(longitude).div(2 * 0.2 * 0.2).add(pow(latitude.add(0.03), 2.0).div(2 * 0.12 * 0.12)).negate()).mul(0.9)
  const dust = galacticDust(galactic)
  const color = mix(vec3(0.82, 0.84, 0.9), vec3(1.0, 0.8, 0.58), bulge.div(disk.add(bulge).add(1e-4)))
  return {light: color.mul(disk.add(bulge)).mul(exp(dust.mul(-1.3))), dust}
}

/** Night sky radiance with the sun's light at `SUN_INTENSITY`: a dark-site sky is ~1e-7 of the daylit zenith. */
const NIGHT_SKY = 1.1e-7

/**
 * The 24-hour sky dome: Preetham's daylight and twilight, the moonlit sky, airglow brightening toward the horizon,
 * the Milky Way, the sun and the phased moon, a billowing cloud deck lit by all of them, and dim desert floor below
 * the horizon. Drawn at the far plane like three's `SkyMesh`. `showDiscs` (a uniform) hides the sun and the moon
 * for environment captures.
 */
export class FoldSky extends Mesh<BoxGeometry, NodeMaterial> {

  readonly showDiscs = uniform(1)

  constructor(sky: SkyUniforms) {
    super(new BoxGeometry(1, 1, 1), new NodeMaterial())
    this.name = 'Sky'
    this.scale.setScalar(10000)
    this.frustumCulled = false
    this.userData.selectable = false

    const material = this.material
    material.name = 'Sky'
    material.side = BackSide
    material.depthWrite = false
    material.fog = false

    material.vertexNode = Fn(() => {
      const position = vec4(modelViewProjection as Node<'vec4'>).toVar()
      position.z.assign(position.w)
      return position
    })()

    const showDiscs = this.showDiscs

    material.colorNode = Fn(() => {
      const direction = normalize(positionWorld.sub(cameraPosition)).toVar()
      const up = max(direction.y, 0.0)
      const airMass = float(1.0).div(up.add(0.025))

      const day = preetham(sky, direction, sky.sunDirection)
      const moonlit = preetham(sky, direction, sky.moonDirection, MOON_MIE, float(MOON_G))
      const dusk = twilight(direction, sky.sunDirection)

      const galactic = sky.galacticFrame.mul(direction)
      const milkyWay = milkyWayGlow(galactic)
      const nightGlow = vec3(0.2, 0.27, 0.42).mul(add(1.0, pow(sub(1.0, up), 8.0).mul(1.5)))
      const night = nightGlow.add(milkyWay.light.mul(sky.milkyWay).mul(3.2).mul(exp(airMass.mul(-0.12)))).mul(NIGHT_SKY)

      const color = day.inscatter.add(moonlit.inscatter.mul(sky.moonLight.mul(MOONLIT_SKY))).add(dusk.color).add(night).toVar()
      const discs = showDiscs.toVar()

      If(direction.y.greaterThan(0.0).and(sky.cloudCoverage.greaterThan(0.0)), () => {
        const {uv, footprint, shape, density, opacity} = cloudAlong(sky, direction)
        const alpha = opacity.mul(smoothstep(0.0, 0.06, direction.y))

        // the light reaching into the cloud from the sun (the moon once the sun is down), marched up through the deck
        // toward it: lit on the sides facing it, dark in the cores and on the far sides, through other clouds when low;
        // the first step close by and with the billows, so each lobe is lit on its sunward side
        const sunUp = sky.sunDirection.y.greaterThan(-0.1)
        const key = select(sunUp, sky.sunDirection, sky.moonDirection)
        const across = length(key.xz).max(1e-4)
        const heading = key.xz.div(across).mul(min(across.div(key.y.max(0.03)).mul(LIGHT_REACH), 1.6).div(1000.0))
        const near = uv.add(heading.mul(0.04))
        let toward: Float = density.mul(0.3).add(cloudErode(shape, cloudBillows(sky, near, footprint)).mul(0.35))
        for (const [t, weight] of LIGHT_STEPS) toward = toward.add(cloudShape(sky, uv.add(heading.mul(t))).mul(weight))
        // toward a grazing light the march sweeps its shading across the deck: it fades to the cloud's own density, a
        // third of which is the light from below (so the light crossing the horizon changes nothing); and the moon
        // takes over from the set sun the same way, as the sun sinks on, the slant easing from the sun's to its own
        const handover = select(sunUp, float(1.0), smoothstep(-0.1, -0.2, sky.sunDirection.y))
        const marched = mix(density.div(3.0), toward, smoothstep(CLOUD_SHADOW_FADE[0], CLOUD_SHADOW_FADE[1], key.y).mul(handover))
        const sine = mix(sky.sunDirection.y.abs(), key.y.abs(), handover)
        // from below the deck (a sun just set for the ground), the light falls straight onto the bases we see
        const keyDepth = cloudDepth(sky, mix(marched.mul(0.6), density.mul(0.2), smoothstep(0.02, -0.02, key.y)), sine)
        // single scattering (Beer's law, phased), and light scattered many times over, deeper and all ways
        const single = exp(keyDepth.negate())
        const multiple = exp(keyDepth.mul(-0.2)).mul(0.6)

        // sunlight and moonlight off cloud droplets (albedo 0.9, over π), the sunlight reddened through the air
        const sunLight = sky.sunIrradiance.mul(CLOUD_ALBEDO / Math.PI)
        const moonLight = sky.moonIrradiance.mul(CLOUD_ALBEDO / Math.PI)
        const direct = sunLight.mul(cloudPhase(day.cosTheta).mul(single).add(multiple))
          .add(moonLight.mul(cloudPhase(moonlit.cosTheta).mul(single).add(multiple)))
        // the sky's light, much less on the thick bases we see from below; the desert's light on them; the twilight
        // glow under them, over the sunken sun
        const ambient = sky.ambient.mul(mix(0.85, 0.35, density))
        const ground = sunLight.mul(max(sky.sunDirection.y, 0.0)).mul(vec3(0.5, 0.47, 0.44)).mul(density.mul(0.25))
        const underglow = dusk.glowColor.mul(dusk.zenith).mul(dusk.sunward.mul(4.0).add(0.1))
        const cloudColor = ambient.add(ground).add(direct).add(underglow)
        color.assign(mix(color, mix(color, cloudColor, day.extinction), alpha))
        discs.mulAssign(sub(1.0, alpha))
      })

      // the sun's disc, capped so it stays within half-float range once pre-exposed
      const sunDisc = clamp(day.cosTheta.sub(0.9999566769464484).mul(50000.0), 0.0, 1.0)
      color.addAssign(min(day.lightE.mul(day.extinction), 80.0).mul(760.0).mul(sunDisc).mul(discs))

      // the moon's disc: a sphere lit from the sun's direction, with darker maria
      const moon = sky.moonDirection
      const moonRight = normalize(cross(moon, vec3(0, 1, 0)).add(vec3(1e-5, 0, 0)))
      const moonUp = cross(moonRight, moon)
      const disc = vec2(dot(direction, moonRight), dot(direction, moonUp)).div(MOON_RADIUS)
      const inside = smoothstep(Math.cos(MOON_RADIUS * 1.03), Math.cos(MOON_RADIUS * 0.97), dot(direction, moon))
      const facing = sqrt(max(sub(1.0, dot(disc, disc)), 0.0))
      const surfaceNormal = moonRight.mul(disc.x).add(moonUp.mul(disc.y)).sub(moon.mul(facing))
      const lit = smoothstep(-0.03, 0.08, dot(surfaceNormal, sky.sunDirection))
      const maria = smoothstep(-0.15, 0.35, mx_noise_float(vec3(disc.mul(1.8), 3.7)))
      const albedo = mix(0.14, 0.075, maria)
      const moonRadiance = min(albedo.mul(SUN_INTENSITY / Math.PI).mul(lit).add(0.0004).mul(moonlit.extinction), float(MOON_DISC_LIMIT).div(sky.preExposure))
      color.addAssign(moonRadiance.mul(inside).mul(discs).mul(smoothstep(-0.01, 0.01, moon.y)))

      // dim desert floor below the horizon, lit like the terrain
      const ground = mix(color, vec3(dot(color, vec3(0.2126, 0.7152, 0.0722))), 0.5).mul(vec3(0.34, 0.26, 0.2))
      color.assign(mix(color, ground, smoothstep(0.0, -0.06, direction.y)))

      return vec4(min(color.mul(sky.preExposure), 30000.0), 1.0)
    })()
  }

  override dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}

/*
 * The sky on the CPU: the dome's own model (Preetham for the sun and the moon, twilight, night glow) in color, drawn
 * into a small equirectangular radiance map that the terrain's global illumination looks the sky up in, and integrated
 * into the sky's light on level ground, which the exposure adapts to. The Milky Way, the discs and the clouds are left
 * out.
 */

type RGB = [number, number, number]

/** Adds the Preetham sky toward `direction` lit from `light` (at the sun's strength, times `scale`) to `out`. */
function addPreetham(sky: SkyUniforms, direction: Vector3, light: Vector3, mie: number, g: number, scale: number, out: RGB) {
  const lightE = 1000 * Math.max(0, 1 - Math.exp(-(CUTOFF_ANGLE - Math.acos(MathUtils.clamp(light.y, -1, 1))) / 1.5))
  if (lightE === 0 || scale === 0) return
  const zenithAngle = Math.acos(Math.max(0, direction.y))
  const inverse = 1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - zenithAngle * 180 / Math.PI, -1.253))
  const cosTheta = direction.dot(light)
  const rPhase = 3 / (16 * Math.PI) * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2))
  const mPhase = 1 / (4 * Math.PI) * (1 - g * g) / Math.pow(1 - 2 * g * cosTheta + g * g, 1.5)
  const horizon = MathUtils.clamp(Math.pow(1 - light.y, 5), 0, 1)
  for (let c = 0; c < 3; c++) {
    const betaR = TOTAL_RAYLEIGH[c] * sky.rayleigh.value
    const betaM = 0.434 * 0.2 * sky.turbidity.value * 10E-18 * MIE_CONST[c] * sky.mieCoefficient.value * mie
    const extinction = Math.exp(-(betaR * 8.4E3 + betaM * 1.25E3) * inverse)
    const ratio = (betaR * rPhase + betaM * mPhase) / (betaR + betaM)
    out[c] += Math.pow(lightE * ratio * (1 - extinction), 1.5) * MathUtils.lerp(1, Math.sqrt(lightE * ratio * extinction), horizon) * 0.04 * scale
  }
}

function hermite(edge0: number, edge1: number, x: number) {
  const t = MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Adds the twilight term toward `direction` (`twilight()` on the GPU) to `out`. */
function addTwilight(direction: Vector3, sun: Vector3, out: RGB) {
  const weight = hermite(0.02, -0.05, sun.y)
  if (weight === 0) return
  const depression = MathUtils.radToDeg(Math.asin(Math.max(-sun.y, 0)))
  const zenith = 0.08 * Math.pow(10, -0.4 * depression) * weight
  const up = Math.max(direction.y, 0)
  const cosAzimuth = (sun.x * direction.x + sun.z * direction.z) / Math.max(Math.hypot(sun.x, sun.z) * Math.hypot(direction.x, direction.z), 1e-5)
  const sunward = Math.pow(cosAzimuth * 0.5 + 0.5, 3)
  const antisolar = Math.pow(0.5 - cosAzimuth * 0.5, 2)
  const reddening = hermite(0, 10, depression)
  const glow = sunward * Math.exp(-up / MathUtils.lerp(0.25, 0.07, hermite(0, 12, depression))) * 3
  const beltHeight = depression * 0.012 + 0.05
  const belt = antisolar * Math.exp(-Math.pow((up - beltHeight) / 0.05, 2)) * 1.6
  const earthShadow = 1 - antisolar * (1 - hermite(0, beltHeight, up)) * 0.6
  const blue = (1.4 - up * 0.8) * earthShadow
  const glowColor: RGB = [MathUtils.lerp(1, 0.85, reddening), MathUtils.lerp(0.55, 0.22, reddening), MathUtils.lerp(0.22, 0.1, reddening)]
  const beltColor: RGB = [1, 0.5, 0.55]
  const blueColor: RGB = [0.22, 0.42, 1]
  for (let c = 0; c < 3; c++) out[c] += (blueColor[c] * blue + glowColor[c] * glow + beltColor[c] * belt) * zenith
}

/** The sky's radiance toward `direction`, in light units (not pre-exposed). */
export function skyRadiance(sky: SkyUniforms, direction: Vector3, out: RGB = [0, 0, 0]): RGB {
  out[0] = out[1] = out[2] = 0
  addPreetham(sky, direction, sky.sunDirection.value, 1, sky.mieDirectionalG.value, 1, out)
  addPreetham(sky, direction, sky.moonDirection.value, MOON_MIE, MOON_G, sky.moonLight.value * MOONLIT_SKY, out)
  addTwilight(direction, sky.sunDirection.value, out)
  const glow = (1 + Math.pow(1 - Math.max(direction.y, 0), 8) * 1.5) * NIGHT_SKY
  out[0] += 0.2 * glow
  out[1] += 0.27 * glow
  out[2] += 0.42 * glow
  return out
}

/** Texels of the sky radiance map, around and from the zenith down to the nadir. */
const SKY_MAP_WIDTH = 48
const SKY_MAP_HEIGHT = 24
/** Albedo of the desert floor around the block, which fills the map below the horizon. */
const GROUND_ALBEDO = 0.25
/**
 * Share of the sky's chroma its light keeps. Multiplying the deep blue of the model's sky into the sand's orange, three
 * channels for two whole spectra, drives the shade olive; the light keeps the sky's luminance and a cool cast, the
 * dome keeps all of its color.
 */
const SKY_LIGHT_CHROMA = 0.55

/**
 * The sky's light as an equirectangular map (rows from the zenith to the nadir, columns around from -x through z),
 * redrawn from the CPU model with the sky, its chroma tempered (`SKY_LIGHT_CHROMA`); below the horizon the desert
 * floor, lit by the sky. `irradiance` is the sky's light on level ground in light units (luminance, not pre-exposed).
 */
export class SkyRadianceMap {

  readonly texture: DataTexture
  irradiance = 0
  private readonly data = new Float32Array(SKY_MAP_WIDTH * SKY_MAP_HEIGHT * 4)

  constructor() {
    this.texture = new DataTexture(this.data, SKY_MAP_WIDTH, SKY_MAP_HEIGHT, RGBAFormat, FloatType)
    this.texture.name = 'Sky Radiance'
    this.texture.wrapS = RepeatWrapping
    this.texture.minFilter = this.texture.magFilter = LinearFilter
    this.texture.needsUpdate = true
  }

  update(sky: SkyUniforms) {
    const data = this.data
    const direction = new Vector3()
    const radiance: RGB = [0, 0, 0]
    const irradiance: RGB = [0, 0, 0]
    const cell = (Math.PI / SKY_MAP_HEIGHT) * (Math.PI * 2 / SKY_MAP_WIDTH)
    for (let row = 0; row < SKY_MAP_HEIGHT / 2; row++) {
      const theta = (row + 0.5) / SKY_MAP_HEIGHT * Math.PI
      const weight = Math.cos(theta) * Math.sin(theta) * cell
      for (let column = 0; column < SKY_MAP_WIDTH; column++) {
        const phi = ((column + 0.5) / SKY_MAP_WIDTH - 0.5) * Math.PI * 2
        direction.set(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi))
        skyRadiance(sky, direction, radiance)
        const luminance = LUMINANCE[0] * radiance[0] + LUMINANCE[1] * radiance[1] + LUMINANCE[2] * radiance[2]
        for (let c = 0; c < 3; c++) radiance[c] = luminance + (radiance[c] - luminance) * SKY_LIGHT_CHROMA
        data.set([radiance[0], radiance[1], radiance[2], 1], (row * SKY_MAP_WIDTH + column) * 4)
        for (let c = 0; c < 3; c++) irradiance[c] += radiance[c] * weight
      }
    }
    for (let row = SKY_MAP_HEIGHT / 2; row < SKY_MAP_HEIGHT; row++) {
      for (let column = 0; column < SKY_MAP_WIDTH; column++) {
        data.set([irradiance[0] * GROUND_ALBEDO / Math.PI, irradiance[1] * GROUND_ALBEDO / Math.PI, irradiance[2] * GROUND_ALBEDO / Math.PI, 1], (row * SKY_MAP_WIDTH + column) * 4)
      }
    }
    this.irradiance = LUMINANCE[0] * irradiance[0] + LUMINANCE[1] * irradiance[1] + LUMINANCE[2] * irradiance[2]
    sky.ambient.value.set(irradiance[0] / Math.PI, irradiance[1] / Math.PI, irradiance[2] / Math.PI)
    this.texture.needsUpdate = true
  }

  dispose() {
    this.texture.dispose()
  }
}

const LUMINANCE = [0.2126, 0.7152, 0.0722] as const

/** Where a direction falls in the sky radiance map. */
export function skyMapUV(direction: Vec3): Vec2 {
  return vec2(atan(direction.z, direction.x).div(Math.PI * 2).add(0.5), acos(clamp(direction.y, -1.0, 1.0)).div(Math.PI))
}
