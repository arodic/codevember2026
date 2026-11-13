import {
  DataTexture, FloatType, FrontSide, IrradianceNode, LinearFilter, LinearMipmapLinearFilter, MeshPhysicalNodeMaterial,
  Node, NodeBuilder, RGBAFormat, RepeatWrapping, Texture,
} from 'three/webgpu'
import {
  abs, attribute, cameraPosition, float, getParallaxCorrectNormal, mix, normalWorldGeometry, normalize,
  pmremTexture, positionWorld, pow, reflect, saturate, select, texture, transformNormalToView, vec3,
} from 'three/tsl'
import type {HollowField} from './HollowField.js'
import type {HollowLighting} from './HollowLighting.js'

/**
 * Physical material lit by a TSL irradiance node (`lightMapNode`). three r187 lacks `NodeMaterial.lightMapNode`.
 */
export class HollowLightMappedMaterial extends MeshPhysicalNodeMaterial {
  lightMapNode: Node<'vec3'> | null = null

  override setupLightMap(builder: NodeBuilder): Node {
    return this.lightMapNode ? new IrradianceNode(this.lightMapNode) : super.setupLightMap(builder)
  }
}

function clamp01(x: number) {
  return Math.min(1, Math.max(0, x))
}

function hash2(ix: number, iy: number) {
  const n = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453
  return n - Math.floor(n)
}

/** CPU-bake a seamless 1024² limestone atlas once (albedo.rgb + roughness.a). */
export function bakeRockDetailAtlas(size = 1024): DataTexture {
  const data = new Float32Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const wx = Math.cos(u * Math.PI * 2)
      const wy = Math.sin(u * Math.PI * 2)
      const wz = Math.cos(v * Math.PI * 2)
      const ww = Math.sin(v * Math.PI * 2)

      const cellX = Math.floor(u * 18)
      const cellY = Math.floor(v * 18)
      let minD = 1e9
      let minD2 = 1e9
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cx = cellX + ox
          const cy = cellY + oy
          const px = (cx + hash2(cx, cy)) / 18
          const py = (cy + hash2(cx + 19, cy + 7)) / 18
          let dx = Math.abs(u - px)
          let dy = Math.abs(v - py)
          dx = Math.min(dx, 1 - dx)
          dy = Math.min(dy, 1 - dy)
          const d = Math.hypot(dx, dy)
          if (d < minD) {
            minD2 = minD
            minD = d
          } else if (d < minD2) {
            minD2 = d
          }
        }
      }
      const facet = clamp01((minD2 - minD) * 14)
      const fbm = 0.55
        + 0.25 * Math.sin(wx * 3.1 + wz * 2.7)
        + 0.12 * Math.sin(wy * 7.3 + ww * 5.1)
        + 0.08 * Math.sin((wx + ww) * 13.0)
      const crack = Math.pow(clamp01(1.0 - Math.abs(Math.sin(u * 40 + v * 17) * Math.cos(v * 33))), 8)
      const pit = Math.pow(clamp01(0.55 - minD * 3.2), 2)

      const baseR = 0.52 + 0.12 * fbm + 0.08 * facet
      const baseG = 0.46 + 0.10 * fbm + 0.05 * facet
      const baseB = 0.40 + 0.08 * fbm
      const spar = pit * 0.35
      const i = (y * size + x) * 4
      data[i] = clamp01(baseR - crack * 0.18 + spar)
      data[i + 1] = clamp01(baseG - crack * 0.16 + spar * 0.9)
      data[i + 2] = clamp01(baseB - crack * 0.12 + spar * 0.7)
      data[i + 3] = clamp01(0.72 - facet * 0.18 - spar * 0.35 + crack * 0.2 + pit * 0.1)
    }
  }

  const tex = new DataTexture(data, size, size, RGBAFormat, FloatType)
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.magFilter = LinearFilter
  tex.minFilter = LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  tex.name = 'Hollow Rock Detail Atlas'
  return tex
}

/** Seamless travertine micro-terrace / sinter atlas (albedo.rgb + roughness.a). */
export function bakeTravertineAtlas(size = 1024): DataTexture {
  const data = new Float32Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const terrace = Math.abs(Math.sin(v * Math.PI * 28 + Math.sin(u * Math.PI * 6) * 0.8))
      const scallop = Math.pow(terrace, 0.45)
      const sparkle = Math.pow(Math.max(0, Math.sin(u * 90) * Math.cos(v * 70)), 16)
      const i = (y * size + x) * 4
      data[i] = clamp01(0.72 + 0.12 * scallop + sparkle * 0.2)
      data[i + 1] = clamp01(0.58 + 0.10 * scallop + sparkle * 0.15)
      data[i + 2] = clamp01(0.40 + 0.08 * scallop)
      data[i + 3] = clamp01(0.55 - scallop * 0.2 - sparkle * 0.4)
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, FloatType)
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.magFilter = LinearFilter
  tex.minFilter = LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  tex.name = 'Hollow Travertine Atlas'
  return tex
}

export interface HollowRockMaterialOptions {
  field: HollowField
  lighting: HollowLighting
  rockAtlas: DataTexture
  travertineAtlas: DataTexture
  styleMode: Node<'float'>
  waterLevel: Node<'float'>
}

/**
 * Wet limestone: world-space triplanar + wet clearcoat.
 * Indirect GI comes from the visible `LightProbeGrid` via three's automatic `LightProbeGridNode`.
 *
 * NOTE: 3D-SDF normal/AO sampling is intentionally omitted for now — `texture3D(sdf)` produced NaN normals
 * that blacked out the cavern even when collar weight was 0 (`mix(geo, NaN, 0)`). Reintroduce once the volume
 * bind is proven on r187.
 */
export function createHollowRockMaterial(opts: HollowRockMaterialOptions): HollowLightMappedMaterial {
  const {lighting, rockAtlas, travertineAtlas, styleMode} = opts

  const material = new HollowLightMappedMaterial({
    roughness: 0.62,
    metalness: 0.0,
    clearcoat: 0.0,
    clearcoatRoughness: 0.08,
    side: FrontSide,
  })
  material.name = 'Hollow Karst Rock'

  const zoneAttr = attribute('aZone', 'vec4')
  const worldN = normalWorldGeometry

  const bw = abs(worldN).pow(5.0)
  const bSum = bw.x.add(bw.y).add(bw.z).max(1e-4)
  const b = bw.div(bSum)
  const scale = float(0.42)
  const rockMap = texture(rockAtlas)
  const travMap = texture(travertineAtlas)
  const sampleTri = (map: typeof rockMap) => {
    const xS = map.sample(positionWorld.zy.mul(scale))
    const yS = map.sample(positionWorld.xz.mul(scale))
    const zS = map.sample(positionWorld.xy.mul(scale))
    return xS.mul(b.x).add(yS.mul(b.y)).add(zS.mul(b.z))
  }
  const rockSample = sampleTri(rockMap)
  const travSample = sampleTri(travMap)
  const detail = mix(rockSample, travSample, zoneAttr.y.mul(0.85).add(zoneAttr.z.mul(0.55)))

  const wetness = zoneAttr.w
  const dryAlbedo = detail.rgb.mul(mix(float(1.0), float(0.92), zoneAttr.x.mul(0.35))).mul(1.2)
  const wetAlbedo = pow(dryAlbedo, vec3(1.25)).mul(0.75)
  const albedo = mix(dryAlbedo, wetAlbedo, wetness)

  const zoneHost = albedo.mul(vec3(0.9, 0.82, 0.72))
  const zoneTint = mix(
    mix(zoneHost, albedo.mul(vec3(1.15, 0.78, 0.45)), zoneAttr.x.mul(0.55)),
    albedo.mul(vec3(1.2, 0.95, 0.6)),
    zoneAttr.y.mul(0.45),
  )
  const zoneFinal = mix(zoneTint, albedo.mul(vec3(1.25, 0.8, 0.35)), zoneAttr.z.mul(0.4))

  material.colorNode = select(styleMode.greaterThanEqual(0.5), zoneFinal, albedo)
  material.roughnessNode = mix(detail.a, float(0.18), wetness.mul(0.85))
  material.clearcoatNode = wetness.mul(0.92)
  material.clearcoatRoughnessNode = mix(float(0.12), float(0.04), wetness)

  const coatN = normalize(mix(worldN, vec3(0, 1, 0), wetness.mul(0.35)))
  material.clearcoatNormalNode = transformNormalToView(coatN)

  // Rim emissive off while isolating bake lights (was a fixed cyan/orange edge glow).
  void lighting
  material.emissiveNode = null

  return material
}

/** Assign parallax-corrected dual PMREM env after bake completes. */
export function applyHollowRockEnv(
  material: HollowLightMappedMaterial,
  lakeMap: Texture | null,
  skyMap: Texture | null,
  field: HollowField,
) {
  if (!lakeMap || !skyMap) {
    material.envNode = null
    material.needsUpdate = true
    return
  }
  const blendedWorldNormal = material.normalNode
  void blendedWorldNormal
  const viewDir = normalize(cameraPosition.sub(positionWorld))
  // Use geometry normal for reflection vector (env is view-dependent enough)
  const refl = reflect(viewDir.negate(), normalWorldGeometry)
  const lakeUv = getParallaxCorrectNormal(refl, vec3(18, 10, 22), vec3(0, 2.5, -4))
  const skyUv = getParallaxCorrectNormal(
    refl,
    vec3(16, 12, 16),
    vec3(field.skylightCenter.x, 5.0, field.skylightCenter.z),
  )
  const lakeEnv = pmremTexture(lakeMap, lakeUv)
  const skyEnv = pmremTexture(skyMap, skyUv)
  material.envNode = mix(lakeEnv, skyEnv, saturate(positionWorld.z.mul(-0.04).add(0.35)))
  material.envMapIntensity = 0.55
  material.needsUpdate = true
}
