import {
  BackSide, BufferAttribute, BufferGeometry, CustomBlending, DoubleSide, InstancedBufferGeometry, Mesh,
  MeshBasicNodeMaterial, Node, OneFactor, OneMinusSrcAlphaFactor, SphereGeometry, StorageBufferNode, Vector3,
} from 'three/webgpu'
import {
  Fn, abs, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, cameraWorldMatrix, clamp, cos, cross, dot, exp,
  float, fract, hash, instanceIndex, int, length, max, mix, normalize, positionGeometry, positionLocal,
  positionPrevious, pow, saturate, screenSize, select, sin, smoothstep, sqrt, storage, texture3D, uniform, varying,
  vec2, vec3, vec4,
} from 'three/tsl'
import {
  BARB_COUNT, BARBULE_SEGMENTS, RACHIS_NODES, STEM_NODES, STEM_RENDER_SEGMENTS, TOTAL_STEM_NODES,
} from './FeatherMorphology.js'
import {
  TOTAL_BARB_META_VEC4S, TOTAL_RACHIS_DYNAMIC_VEC4S, TOTAL_STEM_AUX_VEC4S,
} from './FeatherPhysics.js'
import type { FeatherPhysics } from './FeatherPhysics.js'
import type { FeatherVolume } from './FeatherVolume.js'

const maxInt = (a: Node<'int'>, b: number | Node<'int'>): Node<'int'> => {
  const bNode = typeof b === 'number' ? int(b) : b
  return select(a.greaterThan(bNode), a, bNode)
}

const minInt = (a: Node<'int'>, b: number | Node<'int'>): Node<'int'> => {
  const bNode = typeof b === 'number' ? int(b) : b
  return select(a.lessThan(bNode), a, bNode)
}

export function createFeatherShadingUniforms() {
  return {
    /** Studio backlight softbox direction (from scene point toward upper-right-back softbox). */
    keyDirection: uniform(new Vector3(0.50, 0.46, -0.73).normalize()),
    /** Front-top-right key-wrap studio fill direction (drives cuticle R highlight & snowy pith). */
    fillDirection: uniform(new Vector3(0.34, 0.54, 0.77).normalize()),
    /** Linear radiance of backlight softbox (drives Marschner TT forward transmission glow). */
    keyColor: uniform(new Vector3(1.52, 1.58, 1.72)),
    /** Linear radiance of front studio fill. */
    fillColor: uniform(new Vector3(0.84, 0.90, 1.0)),
    /** Cool cerulean-slate ambient sky tint in recessed plumage shadows (`#839cbc` calibrated). */
    skyAmbient: uniform(new Vector3(0.22, 0.33, 0.50)),
    /** Warm-snowy multi-scattered inner plumage glow (`#dce6f5` calibrated). */
    scatterTint: uniform(new Vector3(0.62, 0.70, 0.85)),
    /** Minimum anti-aliased screen footprint width in pixels (`1.35 px` prevents sub-pixel shimmer). */
    minPixelWidth: uniform(1.35),
    /**
     * While a capture looks through the lens, the diameter of the part of the aperture each lens sample stands for
     * (world units, times the capture's `fill`), else 0. Each sample draws a fiber at least as wide as that part of
     * the lens would blur it, so the samples' images of a defocused fiber merge into its bokeh (`fiberMinWidthPx`).
     */
    lensSpread: uniform(0),
    /** The capture's focus distance, where `lensSpread` widens nothing. */
    lensFocus: uniform(5.65),
    /** Translucency / forward TT transmission boost. */
    translucency: uniform(1.0),
    /** Cuticle specular sheen intensity. */
    sheen: uniform(1.0),
    /** Backdrop inverse-tonemapped linear colors matching the reference photograph. */
    bgBottomLeft: uniform(new Vector3(0.0613, 0.1307, 0.2767)),
    bgTopLeft: uniform(new Vector3(0.0701, 0.1426, 0.2919)),
    bgTopCenter: uniform(new Vector3(0.0721, 0.1512, 0.2919)),
    bgGlowRight: uniform(new Vector3(0.265, 0.388, 0.578)),
    bgLowerRight: uniform(new Vector3(0.185, 0.296, 0.482)),
  }
}

export type FeatherShadingUniforms = ReturnType<typeof createFeatherShadingUniforms>

/**
 * The narrowest a fiber is drawn, in pixels: `minPixelWidth`, or while a capture looks through the lens, as wide as
 * the part of the aperture a lens sample stands for blurs it, which is nothing at the focus distance. A move of the
 * lens by `lensSpread` moves the image of a point at `depth` ahead of the camera by `|depth - focus| / focus` of it at
 * that depth, where a world unit spans `pixels`.
 */
function fiberMinWidthPx(shading: FeatherShadingUniforms, depth: Node<'float'>, pixels: Node<'float'>): Node<'float'> {
  const spread = shading.lensSpread.mul(abs(depth.sub(shading.lensFocus))).div(shading.lensFocus).mul(pixels)
  return max(shading.minPixelWidth, spread)
}

/**
 * Memoized layout `Fn`: Marschner / Chiang dielectric beta-keratin fiber BSDF (`eta = 1.55`, white snowy keratin):
 * evaluates curved 3D cylindrical cross-section normals across ribbon `v ∈ [-1, 1]`, longitudinal/azimuthal
 * `R` (cuticle glint), `TT` (strong backlit forward transmission), `TRT` lobes, and aerated medullary pith scattering.
 * Takes all uniforms as explicit arguments per TSL layout `Fn` rules.
 */
const evalKeratinFiberBSDF = Fn(([
  viewDir, tangent, acrossRight, towardCam, vCoord, projWidthPx, medulla, nodalia,
  keyDir, fillDir, keyCol, fillCol, skyAmb, scatterCol, volData, translucency, sheen,
]: [
  Node<'vec3'>, Node<'vec3'>, Node<'vec3'>, Node<'vec3'>, Node<'float'>, Node<'float'>, Node<'float'>, Node<'float'>,
  Node<'vec3'>, Node<'vec3'>, Node<'vec3'>, Node<'vec3'>, Node<'vec3'>, Node<'vec3'>, Node<'vec4'>, Node<'float'>, Node<'float'>,
]) => {
  const T = normalize(tangent)

  // Reconstruct 3D cylindrical cross-section normal across [-1, 1]; soften azimuth smoothly when sub-pixel
  const resolved = smoothstep(0.65, 2.6, projWidthPx)
  const sinGamma = clamp(vCoord.mul(mix(0.45, 0.96, resolved)), -0.97, 0.97)
  const cosGamma = sqrt(max(float(1.0).sub(sinGamma.mul(sinGamma)), 0.04))
  const cylNormal = normalize(acrossRight.mul(sinGamma).add(towardCam.mul(cosGamma)))

  // Volume optical depth & dual-scattering terms from 3D plumage volume
  const tauKey = volData.x
  const ambientVis = volData.y
  const multiScatter = volData.w

  // Dual-scattering Beer-Lambert + forward keratin scattering transmittance (white beta-keratin never goes black!)
  const directTrans = exp(tauKey.mul(-0.55)).mul(0.58).add(exp(tauKey.mul(-0.14)).mul(0.42))

  // Longitudinal fiber angles: sin(theta_i), sin(theta_r)
  const sinThetaR = clamp(dot(viewDir, T), -0.99, 0.99)
  const sinThetaKey = clamp(dot(keyDir, T), -0.99, 0.99)
  const sinThetaFill = clamp(dot(fillDir, T), -0.99, 0.99)

  // Keratin cuticle scale tilt alpha_R ≈ -0.044 rad (-2.5 deg), alpha_TT = -alpha_R / 2
  const alphaR = float(-0.044)
  const alphaTT = float(0.022)
  const betaR = float(0.22)
  const betaTT = float(0.28)

  // Longitudinal Gaussian lobe helper M(theta_h - alpha, beta)
  const sumKey = sinThetaKey.add(sinThetaR)
  const sumFill = sinThetaFill.add(sinThetaR)
  const mRKey = exp(pow(sumKey.sub(alphaR.mul(2.0)), 2.0).negate().div(betaR.mul(betaR).mul(2.0)))
  const mRFill = exp(pow(sumFill.sub(alphaR.mul(2.0)), 2.0).negate().div(betaR.mul(betaR).mul(2.0)))
  const mTTKey = exp(pow(sumKey.sub(alphaTT.mul(2.0)), 2.0).negate().div(betaTT.mul(betaTT).mul(2.0)))

  // Azimuthal projections perpendicular to fiber tangent T
  const vPerp = normalize(viewDir.sub(T.mul(sinThetaR)).add(towardCam.mul(1e-4)))
  const kPerp = normalize(keyDir.sub(T.mul(sinThetaKey)).add(towardCam.mul(1e-4)))

  // Forward transmission alignment: peaks when light is BEHIND the fiber relative to camera (cosPhi < 0 -> forward scatter!)
  const forwardAlignKey = saturate(dot(vPerp, kPerp.negate()).mul(0.5).add(0.5))
  const ttAzimuthal = pow(forwardAlignKey, 3.6).mul(0.78).add(0.22)

  // Dielectric Fresnel (eta = 1.55 -> F0 = 0.0465) on curved cylinder normal
  const halfFill = normalize(fillDir.add(viewDir))
  const halfKey = normalize(keyDir.add(viewDir))
  const cosSpecFill = saturate(dot(cylNormal, halfFill))
  const cosSpecKey = saturate(dot(cylNormal, halfKey))
  const grazing = pow(float(1.0).sub(saturate(dot(cylNormal, viewDir))), 4.0)
  const fresnel = float(0.0465).add(float(0.9535).mul(grazing))

  // Cuticle R specular glint (front fill + rim key) modulated by microscopic nodalia bamboo rings on barbules
  const rLobeFill = mRFill.mul(pow(cosSpecFill, 14.0).mul(0.7).add(0.3)).mul(fresnel.mul(1.8).add(0.14))
  const rLobeKey = mRKey.mul(pow(cosSpecKey, 10.0).mul(0.6).add(0.4)).mul(fresnel.mul(2.1).add(0.12))
  const specularR = fillCol.mul(rLobeFill).add(keyCol.mul(rLobeKey).mul(directTrans)).mul(nodalia).mul(sheen)

  // Dielectric TT forward-transmitted glow through clear keratin cortex (stronger in thin translucent barbules, softer in thick pith)
  const cortexClear = float(1.0).sub(medulla.mul(0.42))
  const ttGlow = keyCol.mul(mTTKey.mul(0.55).add(0.45)).mul(ttAzimuthal).mul(directTrans)
    .mul(cortexClear).mul(translucency).mul(0.92)

  // TRT internal secondary reflection glow (adds pearlescent silver warmth near cylinder edges)
  const edgeGlow = smoothstep(0.25, 0.92, abs(sinGamma)).mul(0.35).add(0.65)
  const trtGlow = fillCol.mul(0.22).add(keyCol.mul(0.28).mul(directTrans)).mul(edgeGlow).mul(sheen)

  // Aerated medullary pith scattering (bright snowy-white core inside rachis & primary barb stems, subtle in barbules)
  const wrapFill = saturate(dot(cylNormal, fillDir).mul(0.55).add(0.45))
  const wrapKey = saturate(dot(cylNormal, keyDir).mul(0.5).add(0.5)).mul(directTrans)
  const coreProfile = mix(float(0.42), pow(cosGamma, 0.55).mul(0.95).add(0.18), medulla)
  const pithScatter = fillCol.mul(wrapFill.mul(0.58)).add(keyCol.mul(wrapKey.mul(0.42))).mul(coreProfile)

  // Cool cerulean-slate sky ambient + snowy dual-scattered inner plumage bounce
  const ambientLight = skyAmb.mul(ambientVis).mul(mix(0.72, 1.05, cosGamma))
    .add(scatterCol.mul(multiScatter).mul(0.48))

  return ambientLight.add(pithScatter).add(ttGlow).add(trtGlow).add(specularR)
}, {
  viewDir: 'vec3', tangent: 'vec3', acrossRight: 'vec3', towardCam: 'vec3',
  vCoord: 'float', projWidthPx: 'float', medulla: 'float', nodalia: 'float',
  keyDir: 'vec3', fillDir: 'vec3', keyCol: 'vec3', fillCol: 'vec3',
  skyAmb: 'vec3', scatterCol: 'vec3', volData: 'vec4', translucency: 'float', sheen: 'float',
  return: 'vec3',
})

/**
 * Distant studio cyclorama sphere matching the exact measured sRGB gradient of the macro reference photograph
 * (`#46658f` lower-left, `#4b6993` upper-left, `#4c6c93` top-center, sweeping into `#85a0c2` upper-right backlight softbox).
 */
export class FeatherBackdrop extends Mesh<SphereGeometry, MeshBasicNodeMaterial> {

  constructor(shading: FeatherShadingUniforms) {
    const geometry = new SphereGeometry(48, 48, 32)
    const material = new MeshBasicNodeMaterial()
    super(geometry, material)
    this.name = 'StudioBackdrop'
    this.frustumCulled = false
    this.renderOrder = -10
    this.userData.selectable = false

    material.name = 'StudioBackdrop'
    material.side = BackSide
    material.depthWrite = true
    material.depthTest = true
    material.fog = false

    material.colorNode = Fn(() => {
      // In the backdrop's own space, which the camera rig carries round with the camera: the view ray from the macro
      // camera's place around its optical axis (-Z), so parallax under thin-lens aperture shifts stays physical
      const rel = positionLocal.sub(vec3(0.42, -0.18, 5.65))
      const dir = normalize(rel)
      const u = clamp(dir.x.div(max(dir.z.negate(), 0.25)).div(0.78).add(0.5), 0.0, 1.0)
      const v = clamp(dir.y.div(max(dir.z.negate(), 0.25)).div(0.33).add(0.5), 0.0, 1.0)

      // Left vertical gradient (#46658f -> #4b6993) + subtle top-center lift (#4c6c93)
      const leftCol = mix(shading.bgBottomLeft, shading.bgTopLeft, smoothstep(0.05, 0.96, v))
      const centerTopLift = shading.bgTopCenter.sub(shading.bgTopLeft).mul(
        smoothstep(0.22, 0.55, u).mul(float(1.0).sub(smoothstep(0.55, 0.88, u))).mul(smoothstep(0.45, 1.0, v)),
      )
      const baseSlate = leftCol.add(centerTopLift)

      // Elliptical upper-right backlight softbox bloom (#85a0c2) + lower-right warm-slate wrap (#7491b6)
      const dx = u.sub(1.02).div(0.54)
      const dy = v.sub(0.92).div(0.76)
      const softbox = exp(dx.mul(dx).add(dy.mul(dy)).mul(-1.95))
      const rightSweep = pow(smoothstep(0.36, 1.0, u), 1.55).mul(mix(0.52, 1.0, smoothstep(0.0, 0.85, v)))

      const rightCol = mix(shading.bgLowerRight, shading.bgGlowRight, smoothstep(0.25, 0.95, v))
      const gradLinear = mix(baseSlate, rightCol, clamp(softbox.mul(0.74).add(rightSweep.mul(0.38)), 0.0, 1.0))

      const dither = fract(sin(dot(positionLocal.xy, vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5).mul(0.0009)
      return max(gradLinear.add(vec3(dither)), vec3(0.0))
    })()
  }

  override dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}

/** Builds a single strip geometry with `segments` subdivisions along `u ∈ [0, 1]` and `v ∈ [-1, 1]` across width. */
function createRibbonGeometry(segments: number): BufferGeometry {
  const rowCount = segments + 1
  const positions = new Float32Array(rowCount * 2 * 3)
  const uvs = new Float32Array(rowCount * 2 * 2)
  const indices: number[] = []

  for (let i = 0; i < rowCount; i++) {
    const u = i / segments
    const baseV = i * 2
    positions[(baseV + 0) * 3 + 0] = u
    positions[(baseV + 0) * 3 + 1] = -1
    positions[(baseV + 1) * 3 + 0] = u
    positions[(baseV + 1) * 3 + 1] = 1

    uvs[(baseV + 0) * 2 + 0] = u
    uvs[(baseV + 0) * 2 + 1] = 0
    uvs[(baseV + 1) * 2 + 0] = u
    uvs[(baseV + 1) * 2 + 1] = 1

    if (i < segments) {
      const a = baseV
      const b = baseV + 1
      const c = baseV + 2
      const d = baseV + 3
      indices.push(a, b, c, b, d, c)
    }
  }

  const geom = new BufferGeometry()
  geom.setAttribute('position', new BufferAttribute(positions, 3))
  geom.setAttribute('uv', new BufferAttribute(uvs, 2))
  geom.setIndex(indices)
  return geom
}

/**
 * Evaluates an exact endpoint-interpolating `C^2` uniform cubic B-spline (`phantom end knots 2*p0 - p1`)
 * along a 20-node barb stem (`baseNode + 0..19`), returning `(pos.xyz, envRadius)` and analytical tangent `T`.
 */
function sampleBarbBSpline(
  stemPos: StorageBufferNode<'vec4'>,
  baseNode: Node<'int'>,
  s: Node<'float'>,
) {
  const u = clamp(s, 0.0, 1.0).mul(float(STEM_NODES - 1))
  const j = minInt(int(u), STEM_NODES - 2)
  const t = u.sub(float(j))

  const p0 = stemPos.element(baseNode.add(j))
  const p1 = stemPos.element(baseNode.add(j.add(1)))

  const pMinus = select(
    j.equal(0),
    p0.mul(2.0).sub(p1),
    stemPos.element(baseNode.add(maxInt(j.sub(1), 0))),
  )
  const pPlus = select(
    j.greaterThanEqual(STEM_NODES - 2),
    p1.mul(2.0).sub(p0),
    stemPos.element(baseNode.add(minInt(j.add(2), STEM_NODES - 1))),
  )

  const t2 = t.mul(t)
  const t3 = t2.mul(t)
  const omt = float(1.0).sub(t)
  const w0 = omt.mul(omt).mul(omt).div(6.0)
  const w1 = t3.mul(3.0).sub(t2.mul(6.0)).add(4.0).div(6.0)
  const w2 = t3.mul(-3.0).add(t2.mul(3.0)).add(t.mul(3.0)).add(1.0).div(6.0)
  const w3 = t3.div(6.0)

  const dw0 = omt.mul(omt).mul(-0.5)
  const dw1 = t2.mul(1.5).sub(t.mul(2.0))
  const dw2 = t2.mul(-1.5).add(t).add(0.5)
  const dw3 = t2.mul(0.5)

  const splineVec = pMinus.mul(w0).add(p0.mul(w1)).add(p1.mul(w2)).add(pPlus.mul(w3))
  const tangentRaw = pMinus.xyz.mul(dw0).add(p0.xyz.mul(dw1)).add(p1.xyz.mul(dw2)).add(pPlus.xyz.mul(dw3))
  return {
    pos: splineVec.xyz,
    envRadius: splineVec.w,
    tangent: normalize(tangentRaw),
  }
}

/**
 * View ray and orthonormal billboard ribbon basis (`across`, `toward`) valid for both perspective cameras and
 * parallel-ray orthographic axis views (`Top`, `Bottom`, `Left`, `Right`, `Front`, `Back`), with a collinearity guard
 * when a strand tangent aligns with the viewing axis.
 */
function computeRibbonBasis(center: Node<'vec3'>, tangent: Node<'vec3'>) {
  const isOrtho = cameraProjectionMatrix.mul(vec4(0.0, 0.0, 0.0, 1.0)).w.greaterThan(0.5)
  const orthoDir = normalize(cameraWorldMatrix.mul(vec4(0.0, 0.0, 1.0, 0.0)).xyz)
  const perspDir = normalize(cameraPosition.sub(center))
  const toCam = select(isOrtho, orthoDir, perspDir)
  const crossRaw = cross(toCam, tangent)
  const fallback = cross(vec3(1.0, 0.0, 0.0), tangent).add(vec3(0.0, 0.0, 1e-4))
  const across = normalize(select(dot(crossRaw, crossRaw).greaterThan(1e-6), crossRaw, fallback))
  const toward = normalize(cross(tangent, across))
  return {across, toward}
}

/**
 * Central Rachis Shaft Mesh (`96` smooth B-spline subdivisions along the 32-node Cosserat rachis).
 */
export class RachisMesh extends Mesh<BufferGeometry, MeshBasicNodeMaterial> {

  constructor(physics: FeatherPhysics, volume: FeatherVolume, shading: FeatherShadingUniforms) {
    const geometry = createRibbonGeometry(96)
    const material = new MeshBasicNodeMaterial()
    super(geometry, material)
    this.name = 'FeatherRachis'
    this.frustumCulled = false
    this.renderOrder = 1

    material.name = 'FeatherRachis'
    material.side = DoubleSide
    material.transparent = true
    material.depthTest = true
    material.depthWrite = true
    material.fog = false
    material.blending = CustomBlending
    material.blendSrc = OneFactor
    material.blendDst = OneMinusSrcAlphaFactor

    const rachisPos = storage(physics.rachisDynamicBuffer, 'vec4', TOTAL_RACHIS_DYNAMIC_VEC4S).toReadOnly()

    const vWorldPos = varying(vec3(), 'vRachisWorld')
    const vTangent = varying(vec3(), 'vRachisTangent')
    const vAcross = varying(vec3(), 'vRachisAcross')
    const vTowardCam = varying(vec3(), 'vRachisToward')
    const vRibbon = varying(vec3(), 'vRachisRibbon')
    const vMedulla = varying(float(), 'vRachisMedulla')

    material.positionNode = Fn(() => {
      const s = positionGeometry.x
      const sideV = positionGeometry.y

      const u = clamp(s, 0.0, 1.0).mul(float(RACHIS_NODES - 1))
      const j = minInt(int(u), RACHIS_NODES - 2)
      const t = u.sub(float(j))
      const p0 = rachisPos.element(j)
      const p1 = rachisPos.element(j.add(1))
      const pMinus = select(j.equal(0), p0.mul(2.0).sub(p1), rachisPos.element(maxInt(j.sub(1), 0)))
      const pPlus = select(j.greaterThanEqual(RACHIS_NODES - 2), p1.mul(2.0).sub(p0), rachisPos.element(minInt(j.add(2), RACHIS_NODES - 1)))

      const t2 = t.mul(t)
      const t3 = t2.mul(t)
      const omt = float(1.0).sub(t)
      const centerW = pMinus.mul(omt.mul(omt).mul(omt).div(6.0))
        .add(p0.mul(t3.mul(3.0).sub(t2.mul(6.0)).add(4.0).div(6.0)))
        .add(p1.mul(t3.mul(-3.0).add(t2.mul(3.0)).add(t.mul(3.0)).add(1.0).div(6.0)))
        .add(pPlus.mul(t3.div(6.0)))

      const tangRaw = pMinus.xyz.mul(omt.mul(omt).mul(-0.5))
        .add(p0.xyz.mul(t2.mul(1.5).sub(t.mul(2.0))))
        .add(p1.xyz.mul(t2.mul(-1.5).add(t).add(0.5)))
        .add(pPlus.xyz.mul(t2.mul(0.5)))

      const center = centerW.xyz
      const radius = max(centerW.w, 0.0005)
      const T = normalize(tangRaw)
      const {across, toward} = computeRibbonBasis(center, T)

      // Screen-space minimum-width clamping for energy-conserving AA near distal rachis tip
      const clipCenter = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(center, 1.0)))
      const clipEdge = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(center.add(across.mul(radius)), 1.0)))
      const halfWidthPx = length(
        clipEdge.xy.div(max(clipEdge.w, 1e-4)).sub(clipCenter.xy.div(max(clipCenter.w, 1e-4))).mul(screenSize).mul(0.5),
      )
      const minWidthPx = fiberMinWidthPx(shading, clipCenter.w, halfWidthPx.div(radius))
      const minHalfPx = minWidthPx.mul(0.5)
      const scaleExpand = max(minHalfPx.div(max(halfWidthPx, 1e-4)), 1.0)
      const expandedRadius = radius.mul(scaleExpand)

      const worldVertex = center.add(across.mul(sideV.mul(expandedRadius))).add(toward.mul(radius.mul(0.35)))
      vWorldPos.assign(worldVertex)
      vTangent.assign(T)
      vAcross.assign(across)
      vTowardCam.assign(toward)
      vRibbon.assign(vec3(sideV, halfWidthPx.mul(2.0), minWidthPx))
      vMedulla.assign(mix(float(0.92), float(0.45), pow(s, 1.2)))
      positionPrevious.assign(worldVertex)

      return worldVertex
    })()

    material.colorNode = buildFiberFragmentNode(
      vWorldPos, vTangent, vAcross, vTowardCam, vRibbon, vMedulla, float(1.0), volume, shading, false,
    )
  }

  override dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}

/**
 * 128 Connected `C^2` B-Spline Barb Stems (`BarbMesh`), drawn in GPU back-to-front order (`sortedBarbIndicesBuffer`)
 * or as a depth-only optical CoC anchor (`depthOnly = true`).
 */
export class BarbMesh extends Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial> {

  constructor(physics: FeatherPhysics, volume: FeatherVolume, shading: FeatherShadingUniforms, depthOnly = false) {
    const strip = createRibbonGeometry(STEM_RENDER_SEGMENTS)
    const geometry = new InstancedBufferGeometry()
    geometry.setAttribute('position', strip.getAttribute('position'))
    geometry.setAttribute('uv', strip.getAttribute('uv'))
    geometry.setIndex(strip.getIndex())
    geometry.instanceCount = BARB_COUNT

    const material = new MeshBasicNodeMaterial()
    super(geometry, material)
    this.name = depthOnly ? 'FeatherBarbsDepth' : 'FeatherBarbs'
    this.frustumCulled = false
    this.renderOrder = depthOnly ? 4 : 2
    if (depthOnly) this.userData.selectable = false

    material.name = this.name
    material.side = DoubleSide
    material.depthTest = true
    material.fog = false
    if (depthOnly) {
      material.colorWrite = false
      material.depthWrite = true
      material.transparent = false
    } else {
      material.transparent = true
      material.depthWrite = false
      material.blending = CustomBlending
      material.blendSrc = OneFactor
      material.blendDst = OneMinusSrcAlphaFactor
    }

    const stemPos = storage(physics.stemPosBuffer, 'vec4', TOTAL_STEM_NODES).toReadOnly()
    const barbRoot = storage(physics.barbMetaBuffer, 'vec4', TOTAL_BARB_META_VEC4S).toReadOnly()
    const sortedIndices = storage(physics.sortedBarbIndicesBuffer, 'int', BARB_COUNT).toReadOnly()

    const vWorldPos = varying(vec3(), 'vBarbWorld')
    const vTangent = varying(vec3(), 'vBarbTangent')
    const vAcross = varying(vec3(), 'vBarbAcross')
    const vTowardCam = varying(vec3(), 'vBarbToward')
    const vRibbon = varying(vec3(), 'vBarbRibbon')
    const vMedulla = varying(float(), 'vBarbMedulla')

    material.positionNode = Fn(() => {
      const slot = int(instanceIndex)
      const barbIdx = sortedIndices.element(slot)
      const baseNode = barbIdx.mul(STEM_NODES)
      const s = positionGeometry.x
      const sideV = positionGeometry.y

      const spline = sampleBarbBSpline(stemPos, baseNode, s)
      const baseCoreRadius = barbRoot.element(barbIdx).w
      const radius = max(baseCoreRadius.mul(pow(max(float(1.0).sub(s.mul(0.88)), 0.04), 0.78)), 0.00042)

      const center = spline.pos
      const T = spline.tangent
      const {across, toward} = computeRibbonBasis(center, T)

      const clipCenter = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(center, 1.0)))
      const clipEdge = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(center.add(across.mul(radius)), 1.0)))
      const halfWidthPx = length(
        clipEdge.xy.div(max(clipEdge.w, 1e-4)).sub(clipCenter.xy.div(max(clipCenter.w, 1e-4))).mul(screenSize).mul(0.5),
      )
      const minWidthPx = fiberMinWidthPx(shading, clipCenter.w, halfWidthPx.div(radius))
      const minHalfPx = minWidthPx.mul(0.52)
      const scaleExpand = max(minHalfPx.div(max(halfWidthPx, 1e-4)), 1.0)
      const expandedRadius = radius.mul(scaleExpand)

      const worldVertex = center.add(across.mul(sideV.mul(expandedRadius)))
      vWorldPos.assign(worldVertex)
      vTangent.assign(T)
      vAcross.assign(across)
      vTowardCam.assign(toward)
      vRibbon.assign(vec3(sideV, halfWidthPx.mul(2.0), minWidthPx))
      // Aerated snowy pith in lower/mid barb shaft tapering to translucent solid keratin at fine lance tip
      vMedulla.assign(mix(float(0.82), float(0.18), pow(s, 0.85)))
      positionPrevious.assign(worldVertex)

      return worldVertex
    })()

    material.colorNode = buildFiberFragmentNode(
      vWorldPos, vTangent, vAcross, vTowardCam, vRibbon, vMedulla, float(1.0), volume, shading, depthOnly,
    )
  }

  override dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}

/**
 * `65,536` (desktop) / `32,768` (mobile) Instanced 3D Plumulaceous Barbules (`BarbuleMesh`).
 * Reconstructs each barbule's exact arc-length-preserving 4-segment curve from its Layer 2 modal cantilever state
 * `(q1, q2)` welded seamlessly onto the `C^2` parent barb B-spline, sorted back-to-front per barb on the GPU!
 */
export class BarbuleMesh extends Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial> {

  constructor(physics: FeatherPhysics, volume: FeatherVolume, shading: FeatherShadingUniforms, depthOnly = false) {
    const strip = createRibbonGeometry(BARBULE_SEGMENTS)
    const geometry = new InstancedBufferGeometry()
    geometry.setAttribute('position', strip.getAttribute('position'))
    geometry.setAttribute('uv', strip.getAttribute('uv'))
    geometry.setIndex(strip.getIndex())
    geometry.instanceCount = physics.totalBarbules

    const material = new MeshBasicNodeMaterial()
    super(geometry, material)
    this.name = depthOnly ? 'FeatherBarbulesDepth' : 'FeatherBarbules'
    this.frustumCulled = false
    this.renderOrder = depthOnly ? 5 : 3
    this.userData.selectable = false

    material.name = this.name
    material.side = DoubleSide
    material.depthTest = true
    material.fog = false
    if (depthOnly) {
      material.colorWrite = false
      material.depthWrite = true
      material.transparent = false
    } else {
      material.transparent = true
      material.depthWrite = false
      material.blending = CustomBlending
      material.blendSrc = OneFactor
      material.blendDst = OneMinusSrcAlphaFactor
    }

    const perBarb = physics.barbulesPerSide * 2
    const perSide = physics.barbulesPerSide

    const stemPos = storage(physics.stemPosBuffer, 'vec4', TOTAL_STEM_NODES).toReadOnly()
    const stemFrame = storage(physics.stemAuxBuffer, 'vec4', TOTAL_STEM_AUX_VEC4S).toReadOnly()
    const barbRoot = storage(physics.barbMetaBuffer, 'vec4', TOTAL_BARB_META_VEC4S).toReadOnly()
    const sortedIndices = storage(physics.sortedBarbIndicesBuffer, 'int', BARB_COUNT).toReadOnly()
    const barbuleState = storage(physics.barbuleStateBuffer, 'vec4', physics.totalBarbules).toReadOnly()

    const vWorldPos = varying(vec3(), 'vBarbuleWorld')
    const vTangent = varying(vec3(), 'vBarbuleTangent')
    const vAcross = varying(vec3(), 'vBarbuleAcross')
    const vTowardCam = varying(vec3(), 'vBarbuleToward')
    const vRibbon = varying(vec3(), 'vBarbuleRibbon')
    const vNodalia = varying(float(), 'vBarbuleNodalia')

    material.positionNode = Fn(() => {
      const rawInst = int(instanceIndex)
      const sortSlot = rawInst.div(perBarb)
      const localInBarb = rawInst.mod(perBarb)
      const barbIdx = sortedIndices.element(sortSlot)
      // Global physics index of this exact barbule on barbIdx
      const gIdx = barbIdx.mul(perBarb).add(localInBarb)

      const sideIdx = localInBarb.div(perSide)
      const indexAlongVane = localInBarb.mod(perSide)
      const vaneSide = select(sideIdx.equal(0), float(1.0), float(-1.0))

      const s = clamp(
        float(indexAlongVane).add(0.5).div(float(perSide)).mul(0.965).add(0.022),
        0.02,
        0.992,
      )

      const uBarbule = positionGeometry.x
      const sideV = positionGeometry.y

      // Exact C^2 spline socket on parent barb (zero gap between barb shaft and barbule root!)
      const baseNode = barbIdx.mul(STEM_NODES)
      const spline = sampleBarbBSpline(stemPos, baseNode, s)
      const stemP = spline.pos
      const stemT = spline.tangent

      const sScaled = s.mul(float(STEM_NODES - 1))
      const j0 = minInt(int(sScaled), STEM_NODES - 2)
      const jf = sScaled.sub(float(j0))
      const snRaw = mix(stemFrame.element(baseNode.add(j0)).xyz, stemFrame.element(baseNode.add(j0.add(1))).xyz, jf)
      const stemN = normalize(snRaw.sub(stemT.mul(dot(snRaw, stemT))))
      const stemB = normalize(cross(stemT, stemN))

      // Deterministic morphology matching Layer 2 compute (`FeatherPhysics.ts`)
      const hSeed = float(gIdx).mul(1.731)
      const h1 = hash(hSeed)
      const h2 = hash(hSeed.add(19.3))
      const h3 = hash(hSeed.add(47.7))
      const h4 = hash(hSeed.add(83.1))

      const maxBarbuleLen = barbRoot.element(barbIdx).y
      const rootRamp = smoothstep(0.01, 0.12, s)
      const tipLance = float(1.0).sub(smoothstep(0.89, 1.0, s))
      const bodyTaper = pow(max(float(1.0).sub(pow(s, 1.28).mul(0.76)), 0.05), 0.68)
      const lenJitter = float(0.76).add(h1.mul(0.46))
      const barbuleLen = maxBarbuleLen.mul(rootRamp).mul(bodyTaper).mul(tipLance).mul(lenJitter)

      const branchAngle = mix(float(0.645), float(0.332), pow(s, 0.85)).add(h2.sub(0.5).mul(0.19))
      const dihedralAngle = h3.sub(0.46).mul(0.78)

      const outwardB = stemB.mul(vaneSide).mul(cos(dihedralAngle)).add(stemN.mul(sin(dihedralAngle)))
      const restDir = normalize(stemT.mul(cos(branchAngle)).add(outwardB.mul(sin(branchAngle))))
      const eSweep = normalize(stemT.sub(restDir.mul(dot(stemT, restDir))))
      const eLift = normalize(cross(restDir, eSweep))

      // Read Layer 2 modal cantilever deflections (q1 = fundamental bend, q2 = S-whip tip mode) + organic rest arch
      const modal = barbuleState.element(gIdx)
      const q1 = modal.xy
      const q2 = modal.zw
      // Subtle natural rest curve (slight forward tip sweep + gentle downy droop + micro-clump affinity)
      const clumpWave = sin(s.mul(38.0).add(vaneSide.mul(1.7))).mul(0.075)
      const restSweep = float(0.14).add(clumpWave).add(h4.sub(0.5).mul(0.08))
      const restDroop = float(-0.08).add(h2.sub(0.5).mul(0.09))

      const totalSweep1 = q1.x.add(restSweep)
      const totalLift1 = q1.y.add(restDroop)

      // Arc-length-preserving 2-point Gauss-midpoint tangent quadrature from root (0) to uBarbule:
      // evaluates unit tangents at 0.33*u and 0.82*u so the barbule NEVER stretches regardless of bending!
      const evalUnitTangent = (tau: Node<'float'>) => {
        const phi1 = pow(max(tau, 1e-4), 0.85).mul(1.35)
        const phi2 = tau.mul(tau.sub(0.52)).mul(3.1)
        const dSweep = totalSweep1.mul(phi1).add(q2.x.mul(phi2))
        const dLift = totalLift1.mul(phi1).add(q2.y.mul(phi2))
        return normalize(restDir.add(eSweep.mul(dSweep)).add(eLift.mul(dLift)))
      }

      const tA = evalUnitTangent(uBarbule.mul(0.32))
      const tB = evalUnitTangent(uBarbule.mul(0.78))
      const tEnd = evalUnitTangent(uBarbule)
      const center = stemP.add(tA.mul(0.46).add(tB.mul(0.54)).mul(barbuleLen.mul(uBarbule)))

      // Physical microscopic barbule radius: ~4.6 µm (0.00046 cm) at root tapering to ~1.2 µm (0.00012 cm) gossamer needle tip!
      const physRadius = mix(float(0.00046), float(0.00012), pow(uBarbule, 0.78))
        .mul(smoothstep(0.0, 0.025, barbuleLen))

      const {across, toward} = computeRibbonBasis(center, tEnd)

      const clipCenter = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(center, 1.0)))
      const clipEdge = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(center.add(across.mul(physRadius)), 1.0)))
      const halfWidthPx = length(
        clipEdge.xy.div(max(clipEdge.w, 1e-4)).sub(clipCenter.xy.div(max(clipCenter.w, 1e-4))).mul(screenSize).mul(0.5),
      )
      const minWidthPx = fiberMinWidthPx(shading, clipCenter.w, halfWidthPx.div(max(physRadius, 1e-6)))
      const minHalfPx = minWidthPx.mul(0.5)
      const scaleExpand = max(minHalfPx.div(max(halfWidthPx, 1e-5)), 1.0)
      const expandedRadius = physRadius.mul(scaleExpand)

      const visible = barbuleLen.greaterThan(0.008)
      const worldVertex = select(visible, center.add(across.mul(sideV.mul(expandedRadius))), stemP)
      // Microscopic bamboo-like nodalia specular modulation along the barbule
      const nodalia = float(1.0).add(sin(uBarbule.mul(44.0).add(h1.mul(6.28))).mul(0.16))

      vWorldPos.assign(worldVertex)
      vTangent.assign(tEnd)
      vAcross.assign(across)
      vTowardCam.assign(toward)
      // Graceful tip fade in last 10% so microscopic tips dissolve into air like real gossamer keratin
      const tipFade = float(1.0).sub(smoothstep(0.88, 1.0, uBarbule).mul(0.65))
      vRibbon.assign(vec3(sideV, select(visible, halfWidthPx.mul(2.0).mul(tipFade), float(0.0)), minWidthPx))
      vNodalia.assign(nodalia)
      positionPrevious.assign(worldVertex)

      return worldVertex
    })()

    material.colorNode = buildFiberFragmentNode(
      vWorldPos, vTangent, vAcross, vTowardCam, vRibbon, float(0.08), vNodalia, volume, shading, depthOnly,
    )
  }

  override dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}

function buildFiberFragmentNode(
  vWorldPos: Node<'vec3'>,
  vTangent: Node<'vec3'>,
  vAcross: Node<'vec3'>,
  vTowardCam: Node<'vec3'>,
  vRibbon: Node<'vec3'>,
  vMedulla: Node<'float'>,
  vNodalia: Node<'float'>,
  volume: FeatherVolume,
  shading: FeatherShadingUniforms,
  depthOnly: boolean,
): Node<'vec4'> {
  const lightTex = volume.lightTexture
  const bMin = volume.boundsMin
  const bSize = volume.boundsSize

  if (depthOnly) {
    return Fn(() => {
      const vCoord = vRibbon.x
      const projWidthPx = vRibbon.y
      // Continuous unbroken depth corridor along visible filaments (no pinpoint coverage speckling!)
      abs(vCoord).greaterThan(0.76).or(projWidthPx.lessThan(0.06)).discard()
      return vec4(0.0, 0.0, 0.0, 1.0)
    })()
  }

  return Fn(() => {
    const vCoord = vRibbon.x
    const projWidthPx = vRibbon.y
    const minWidthPx = vRibbon.z

    const clampedWidthPx = max(projWidthPx, minWidthPx)
    const energyRatio = clamp(projWidthPx.div(max(clampedWidthPx, 1e-4)), 0.0, 1.0)
    const resolved = smoothstep(1.1, 3.0, projWidthPx)

    const tentProfile = max(float(1.0).sub(abs(vCoord)), 0.0)
    const cylEdge = smoothstep(1.0, 0.68, abs(vCoord))
    const crossAlpha = mix(tentProfile.mul(1.22), cylEdge, resolved)

    const intrinsicOpacity = mix(float(0.68), float(0.97), vMedulla)
    const alpha = clamp(energyRatio.mul(crossAlpha).mul(intrinsicOpacity), 0.0, 1.0)

    const uvw = clamp(vWorldPos.sub(bMin).div(bSize), 0.0, 1.0)
    const volData = texture3D(lightTex, uvw)
    const isOrtho = cameraProjectionMatrix.mul(vec4(0.0, 0.0, 0.0, 1.0)).w.greaterThan(0.5)
    const viewDir = select(
      isOrtho,
      normalize(cameraWorldMatrix.mul(vec4(0.0, 0.0, 1.0, 0.0)).xyz),
      normalize(cameraPosition.sub(vWorldPos)),
    )

    const radiance = evalKeratinFiberBSDF(
      viewDir, vTangent, vAcross, vTowardCam,
      vCoord, projWidthPx, vMedulla, vNodalia,
      shading.keyDirection, shading.fillDirection,
      shading.keyColor, shading.fillColor,
      shading.skyAmbient, shading.scatterTint,
      volData, shading.translucency, shading.sheen,
    )

    // Premultiplied linear HDR output (`CustomBlending: One, OneMinusSrcAlpha`)
    return vec4(radiance.mul(alpha), alpha)
  })()
}
