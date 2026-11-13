import {
  Camera, ComputeNode, Node, StorageBufferAttribute, Vector3, WebGPURenderer,
} from 'three/webgpu'
import {
  Fn, If, Loop, abs, clamp, cos, cross, dot, exp, float, hash, instanceIndex, int, length, localId, max, min, mix,
  mx_noise_vec3, normalize, pow, select, sin, smoothstep, sqrt, storage, uniform, vec2, vec3, vec4, workgroupBarrier,
  workgroupId,
} from 'three/tsl'
import {
  BARB_COUNT, DESKTOP_BARBULES_PER_SIDE, FeatherMorphologyData, RACHIS_NODES, STEM_NODES, TOTAL_STEM_NODES,
  WORKGROUP_BARBULES,
} from './FeatherMorphology.js'
import {
  BARB_TORQUE_OFFSET, CAPSULE_B_OFFSET, CAPSULES_PER_BARB, TOTAL_CAPSULE_TORQUE_VEC4S, sharedArray,
} from './FeatherVolume.js'

const STATIONS_PER_BARB = 4
const TOTAL_STATIONS = BARB_COUNT * STATIONS_PER_BARB

// Packed buffer offsets so every compute shader binds <= 7 storage buffers (WebGPU limit = 8 per stage!)
export const RACHIS_NORMAL_OFFSET = RACHIS_NODES
export const RACHIS_STATE_OFFSET = RACHIS_NODES * 2
export const TOTAL_RACHIS_DYNAMIC_VEC4S = RACHIS_NODES * 2 + 2

export const BARB_STYLE_OFFSET = BARB_COUNT
export const TOTAL_BARB_META_VEC4S = BARB_COUNT * 2

export const STEM_ACCEL_OFFSET = TOTAL_STEM_NODES
export const STEM_CONTACT_OFFSET = TOTAL_STEM_NODES * 2
export const TOTAL_STEM_AUX_VEC4S = TOTAL_STEM_NODES * 3

const maxInt = (a: Node<'int'>, b: number | Node<'int'>): Node<'int'> => {
  const bNode = typeof b === 'number' ? int(b) : b
  return select(a.greaterThan(bNode), a, bNode)
}

const minInt = (a: Node<'int'>, b: number | Node<'int'>): Node<'int'> => {
  const bNode = typeof b === 'number' ? int(b) : b
  return select(a.lessThan(bNode), a, bNode)
}

/**
 * Memoized layout `Fn`: 3-scale divergence-free curl-noise & vortex air velocity field (`cm / s`),
 * strictly periodic over `phase ∈ [0, 2π)` so looping timelines have zero seam.
 * Takes all parameters as explicit arguments (never captures shared uniforms).
 */
export const evalFeatherAirVelocity = Fn(([worldPos, phase, airStrength, thermalLift]: [
  Node<'vec3'>, Node<'float'>, Node<'float'>, Node<'float'>,
]) => {
  const loopOffset = vec3(cos(phase).mul(0.85), sin(phase).mul(0.85), sin(phase.mul(2.0)).mul(0.42))

  // Scale 1 (~11 cm): slow divergence-free room breath moving the entire plume in gentle common-fate unison
  const p1 = worldPos.mul(0.16)
  const breathX = sin(p1.y.mul(1.3).add(phase)).mul(0.52).add(cos(p1.z.mul(1.1).sub(phase.mul(2.0))).mul(0.24))
  const breathY = cos(p1.x.mul(1.2).sub(phase)).mul(0.34).add(thermalLift.mul(0.32))
  const breathZ = sin(p1.x.sub(p1.y).add(phase)).mul(0.38)
  const macroBreath = vec3(breathX, breathY, breathZ)

  // Scale 2 (~2.6 cm): 4-tap forward-difference curl of 3D simplex vector potential (incompressible eddies)
  const eps = float(0.06)
  const q = worldPos.mul(0.42).add(loopOffset)
  const psi0 = mx_noise_vec3(q)
  const psiX = mx_noise_vec3(q.add(vec3(eps, 0.0, 0.0)))
  const psiY = mx_noise_vec3(q.add(vec3(0.0, eps, 0.0)))
  const psiZ = mx_noise_vec3(q.add(vec3(0.0, 0.0, eps)))
  const dX = psiX.sub(psi0).div(eps)
  const dY = psiY.sub(psi0).div(eps)
  const dZ = psiZ.sub(psi0).div(eps)
  const mesoCurl = vec3(dY.z.sub(dZ.y), dZ.x.sub(dX.z), dX.y.sub(dY.x)).mul(0.34)

  // Scale 3 (~0.75 cm): fine traveling shear ripples sweeping upward-left across the vanes (drives barbule waves)
  const wavePhase = worldPos.y.mul(2.8).sub(worldPos.x.mul(2.1)).sub(phase.mul(3.0))
  const wavePhase2 = worldPos.x.mul(3.4).add(worldPos.z.mul(2.9)).add(phase.mul(4.0))
  const microWave = vec3(
    sin(wavePhase).mul(0.19),
    sin(wavePhase).mul(0.14).add(cos(wavePhase2).mul(0.09)),
    cos(wavePhase.mul(1.15).add(1.1)).mul(0.16),
  )

  return macroBreath.add(mesoCurl).add(microWave).mul(airStrength)
}, {worldPos: 'vec3', phase: 'float', airStrength: 'float', thermalLift: 'float', return: 'vec3'})

/**
 * Memoized layout `Fn`: 3D air-wake jet & soft steric brush displacement from viewport pointer ray.
 */
const evalGestureField = Fn(([worldPos, rayOrigin, rayDir, rayVel, strength, radius]: [
  Node<'vec3'>, Node<'vec3'>, Node<'vec3'>, Node<'vec3'>, Node<'float'>, Node<'float'>,
]) => {
  const rel = worldPos.sub(rayOrigin)
  const along = max(dot(rel, rayDir), 0.1)
  const closest = rayOrigin.add(rayDir.mul(along))
  const delta = worldPos.sub(closest)
  const distSq = dot(delta, delta)
  const rSq = max(radius.mul(radius), 1e-4)
  const falloff = exp(distSq.negate().div(rSq)).mul(strength)
  const wakeVel = rayVel.mul(along).mul(1.35)
  const radialPush = delta.div(sqrt(distSq.add(0.02))).mul(length(wakeVel).mul(0.35).add(0.28))
  return wakeVel.add(radialPush).mul(falloff)
}, {
  worldPos: 'vec3', rayOrigin: 'vec3', rayDir: 'vec3', rayVel: 'vec3', strength: 'float', radius: 'float', return: 'vec3',
})

function packRachisRest(morphology: FeatherMorphologyData): Float32Array {
  const packed = new Float32Array(RACHIS_NODES * 2 * 4)
  packed.set(morphology.rachisRestPos, 0)
  packed.set(morphology.rachisRestNormal, RACHIS_NORMAL_OFFSET * 4)
  return packed
}

function packRachisDynamic(morphology: FeatherMorphologyData): Float32Array {
  const packed = new Float32Array(TOTAL_RACHIS_DYNAMIC_VEC4S * 4)
  packed.set(morphology.rachisRestPos, 0)
  packed.set(morphology.rachisRestNormal, RACHIS_NORMAL_OFFSET * 4)
  return packed
}

function packBarbMeta(morphology: FeatherMorphologyData): Float32Array {
  const packed = new Float32Array(TOTAL_BARB_META_VEC4S * 4)
  packed.set(morphology.barbRootInfo, 0)
  packed.set(morphology.barbStyleInfo, BARB_STYLE_OFFSET * 4)
  return packed
}

function packStemAux(morphology: FeatherMorphologyData): Float32Array {
  const packed = new Float32Array(TOTAL_STEM_AUX_VEC4S * 4)
  packed.set(morphology.initialStemFrame, 0)
  return packed
}

/**
 * Two-layer hierarchical WebGPU feather simulation + GPU back-to-front barb depth sorter.
 * Packed storage layout guarantees `<= 7` storage buffers per shader stage (strictly within WebGPU's 8-buffer limit).
 */
export class FeatherPhysics {

  readonly barbulesPerSide: number
  readonly totalBarbules: number

  readonly rachisRestBuffer: StorageBufferAttribute
  readonly rachisDynamicBuffer: StorageBufferAttribute
  readonly barbMetaBuffer: StorageBufferAttribute
  readonly stemLocalRestBuffer: StorageBufferAttribute
  readonly stemPosBuffer: StorageBufferAttribute
  readonly stemVelBuffer: StorageBufferAttribute
  readonly stemAuxBuffer: StorageBufferAttribute
  readonly capsulesAndTorqueBuffer: StorageBufferAttribute
  readonly sortedBarbIndicesBuffer: StorageBufferAttribute
  readonly barbuleStateBuffer: StorageBufferAttribute
  readonly barbuleVelBuffer: StorageBufferAttribute

  // Simulation uniforms
  readonly dtUniform = uniform(1 / 120)
  readonly phaseUniform = uniform(0)
  readonly airStrengthUniform = uniform(1.0)
  readonly thermalLiftUniform = uniform(0.45)
  readonly stemStiffnessUniform = uniform(1.0)
  readonly barbuleWaveUniform = uniform(1.0)
  readonly envelopeComplianceUniform = uniform(1.0)
  /** Structural damping (`1 / s`) of barb motion relative to its rachis socket. */
  readonly stemDampingUniform = uniform(3.0)
  /** Fraction of envelope penetration one stem resolves per substep at full compression. */
  readonly contactStiffnessUniform = uniform(0.12)
  /** Velcro damping (`1 / s` at full compression) of barbs pressed into neighbors' envelopes. */
  readonly contactDampingUniform = uniform(60.0)
  /** Fraction of a collision push kept as velocity: `0` cushions, `1` rebounds (plain PBD). */
  readonly contactBounceUniform = uniform(0.15)
  /** How much of the rest pose's envelope overlap counts as no contact: `1` lets the crowded core rest uncompressed. */
  readonly restOverlapUniform = uniform(1.0)
  /** Scales both barbule bending modes' damping. */
  readonly barbuleDampingUniform = uniform(1.0)

  // Interactive gesture uniforms
  readonly gestureOriginUniform = uniform(new Vector3(0, 0, 6.2))
  readonly gestureDirUniform = uniform(new Vector3(0, 0, -1))
  readonly gestureVelUniform = uniform(new Vector3(0, 0, 0))
  readonly gestureStrengthUniform = uniform(0)
  readonly gestureRadiusUniform = uniform(0.85)

  // Camera sorting uniforms
  readonly cameraPosUniform = uniform(new Vector3(0, 0, 6.2))
  readonly cameraForwardUniform = uniform(new Vector3(0, 0, -1))

  private readonly resetCompute: ComputeNode
  private readonly rachisStepCompute: ComputeNode
  private readonly stemsStepCompute: ComputeNode
  private readonly barbulesStepCompute: ComputeNode
  private readonly sortBarbsCompute: ComputeNode

  constructor(morphology: FeatherMorphologyData, barbulesPerSide = DESKTOP_BARBULES_PER_SIDE) {
    this.barbulesPerSide = barbulesPerSide
    this.totalBarbules = BARB_COUNT * 2 * barbulesPerSide

    this.rachisRestBuffer = new StorageBufferAttribute(packRachisRest(morphology), 4)
    this.rachisDynamicBuffer = new StorageBufferAttribute(packRachisDynamic(morphology), 4)
    this.barbMetaBuffer = new StorageBufferAttribute(packBarbMeta(morphology), 4)
    this.stemLocalRestBuffer = new StorageBufferAttribute(new Float32Array(morphology.stemLocalRest), 4)
    this.stemPosBuffer = new StorageBufferAttribute(new Float32Array(morphology.initialStemPos), 4)
    this.stemVelBuffer = new StorageBufferAttribute(new Float32Array(morphology.initialStemVel), 4)
    this.stemAuxBuffer = new StorageBufferAttribute(packStemAux(morphology), 4)
    this.capsulesAndTorqueBuffer = new StorageBufferAttribute(new Float32Array(TOTAL_CAPSULE_TORQUE_VEC4S * 4), 4)

    const initialOrder = new Int32Array(BARB_COUNT)
    for (let i = 0; i < BARB_COUNT; i++) initialOrder[i] = i
    this.sortedBarbIndicesBuffer = new StorageBufferAttribute(initialOrder, 1)

    this.barbuleStateBuffer = new StorageBufferAttribute(new Float32Array(this.totalBarbules * 4), 4)
    this.barbuleVelBuffer = new StorageBufferAttribute(new Float32Array(this.totalBarbules * 4), 4)

    const rachisRest = storage(this.rachisRestBuffer, 'vec4', RACHIS_NODES * 2).toReadOnly()
    const rachisDynamicRW = storage(this.rachisDynamicBuffer, 'vec4', TOTAL_RACHIS_DYNAMIC_VEC4S)
    const rachisDynamicRO = storage(this.rachisDynamicBuffer, 'vec4', TOTAL_RACHIS_DYNAMIC_VEC4S).toReadOnly()

    const barbMeta = storage(this.barbMetaBuffer, 'vec4', TOTAL_BARB_META_VEC4S).toReadOnly()
    const stemLocalRest = storage(this.stemLocalRestBuffer, 'vec4', TOTAL_STEM_NODES).toReadOnly()
    const stemPosRW = storage(this.stemPosBuffer, 'vec4', TOTAL_STEM_NODES)
    const stemPosRO = storage(this.stemPosBuffer, 'vec4', TOTAL_STEM_NODES).toReadOnly()
    const stemVelRW = storage(this.stemVelBuffer, 'vec4', TOTAL_STEM_NODES)
    const stemVelRO = storage(this.stemVelBuffer, 'vec4', TOTAL_STEM_NODES).toReadOnly()
    const stemAuxRW = storage(this.stemAuxBuffer, 'vec4', TOTAL_STEM_AUX_VEC4S)
    const stemAuxRO = storage(this.stemAuxBuffer, 'vec4', TOTAL_STEM_AUX_VEC4S).toReadOnly()

    const capsulesAndTorqueRW = storage(this.capsulesAndTorqueBuffer, 'vec4', TOTAL_CAPSULE_TORQUE_VEC4S)
    const capsulesAndTorqueRO = storage(this.capsulesAndTorqueBuffer, 'vec4', TOTAL_CAPSULE_TORQUE_VEC4S).toReadOnly()
    const sortedBarbIndices = storage(this.sortedBarbIndicesBuffer, 'int', BARB_COUNT)

    const barbuleState = storage(this.barbuleStateBuffer, 'vec4', this.totalBarbules)
    const barbuleVel = storage(this.barbuleVelBuffer, 'vec4', this.totalBarbules)

    const dt = this.dtUniform
    const phase = this.phaseUniform
    const airStrength = this.airStrengthUniform
    const thermalLift = this.thermalLiftUniform
    const stemStiffness = this.stemStiffnessUniform
    const barbuleWave = this.barbuleWaveUniform
    const envCompliance = this.envelopeComplianceUniform
    const stemDamping = this.stemDampingUniform
    const contactStiffness = this.contactStiffnessUniform
    const contactDamping = this.contactDampingUniform
    const contactBounce = this.contactBounceUniform
    const restOverlap = this.restOverlapUniform
    const barbuleDamping = this.barbuleDampingUniform

    const gOrigin = this.gestureOriginUniform
    const gDir = this.gestureDirUniform
    const gVel = this.gestureVelUniform
    const gStrength = this.gestureStrengthUniform
    const gRadius = this.gestureRadiusUniform

    const camPos = this.cameraPosUniform
    const camFwd = this.cameraForwardUniform

    // Reset compute (5 storage buffers)
    this.resetCompute = Fn(() => {
      const idx = int(instanceIndex)
      If(idx.lessThan(RACHIS_NODES * 2), () => {
        rachisDynamicRW.element(idx).assign(rachisRest.element(idx))
      })
      If(idx.lessThan(2), () => {
        rachisDynamicRW.element(idx.add(RACHIS_STATE_OFFSET)).assign(vec4(0.0))
      })
      If(idx.lessThan(BARB_COUNT), () => {
        capsulesAndTorqueRW.element(idx.add(BARB_TORQUE_OFFSET)).assign(vec4(0.0))
      })
      If(idx.lessThan(this.totalBarbules), () => {
        barbuleState.element(idx).assign(vec4(0.0))
        barbuleVel.element(idx).assign(vec4(0.0))
      })
    })().compute(this.totalBarbules, [128])

    // Layer 0: Central Rachis Cosserat Modal + Two-Way Barb Torque Integration (3 storage buffers)
    const rachisKernel = Fn(() => {
      const wgTorque = sharedArray('vec4', RACHIS_NODES)
      const tid = int(localId.x)

      const partialTorque = vec3(0.0).toVar()
      Loop(4, ({i}) => {
        const bIdx = tid.mul(4).add(i)
        partialTorque.addAssign(capsulesAndTorqueRO.element(bIdx.add(BARB_TORQUE_OFFSET)).xyz)
      })
      wgTorque.element(tid).assign(vec4(partialTorque, 0.0))
      workgroupBarrier()

      If(tid.equal(0), () => {
        const netBarbMoment = vec3(0.0).toVar()
        Loop(RACHIS_NODES, ({i}) => {
          netBarbMoment.addAssign(wgTorque.element(i).xyz)
        })
        const crownAnchor = vec3(0.15, -1.2, 0.0)
        const crownAir = evalFeatherAirVelocity(crownAnchor, phase, airStrength, thermalLift)
        const crownGesture = evalGestureField(crownAnchor, gOrigin, gDir, gVel, gStrength, gRadius)
        const fluidDrive = crownAir.add(crownGesture.mul(1.25))

        const targetAngles = vec3(
          fluidDrive.x.mul(0.018).add(netBarbMoment.x.mul(0.0028)),
          fluidDrive.z.mul(0.016).add(netBarbMoment.y.mul(0.0026)),
          fluidDrive.z.mul(0.022).sub(fluidDrive.x.mul(0.012)).add(netBarbMoment.z.mul(0.0032)),
        )
        const maxAngle = vec3(0.065, 0.065, 0.085)
        const clampedTarget = targetAngles.div(sqrt(vec3(1.0).add(targetAngles.mul(targetAngles).div(maxAngle.mul(maxAngle)))))

        const angles = rachisDynamicRW.element(int(RACHIS_STATE_OFFSET)).xyz.toVar()
        const omega = rachisDynamicRW.element(int(RACHIS_STATE_OFFSET + 1)).xyz.toVar()
        const stiffnessK = float(7.5).mul(stemStiffness)
        const dampingC = float(4.2)
        const accel = clampedTarget.sub(angles).mul(stiffnessK).sub(omega.mul(dampingC))
        omega.assign(omega.add(accel.mul(dt)).mul(exp(dt.mul(-1.6))))
        angles.addAssign(omega.mul(dt))

        rachisDynamicRW.element(int(RACHIS_STATE_OFFSET)).assign(vec4(angles, 0.0))
        rachisDynamicRW.element(int(RACHIS_STATE_OFFSET + 1)).assign(vec4(omega, 0.0))
      })

      workgroupBarrier()

      const restP = rachisRest.element(tid)
      const restN = rachisRest.element(tid.add(RACHIS_NORMAL_OFFSET))
      const baseP = rachisRest.element(int(0)).xyz
      const prevRest = rachisRest.element(maxInt(tid.sub(1), 0)).xyz
      const nextRest = rachisRest.element(minInt(tid.add(1), RACHIS_NODES - 1)).xyz
      const restT = normalize(nextRest.sub(prevRest))

      const s = float(tid).div(float(RACHIS_NODES - 1))
      const cantilever = pow(s, 1.68)
      const angles = rachisDynamicRW.element(int(RACHIS_STATE_OFFSET)).xyz
      const rel = restP.xyz.sub(baseP)

      const swayOffset = vec3(
        angles.x.mul(4.8).mul(cantilever),
        angles.x.abs().mul(-0.18).mul(cantilever),
        angles.y.mul(4.8).mul(cantilever),
      )
      const twistAngle = angles.z.mul(pow(s, 1.25))
      const cosTw = cos(twistAngle)
      const sinTw = sin(twistAngle)
      const restB = normalize(cross(restT, restN.xyz))
      const twistedN = normalize(restN.xyz.mul(cosTw).add(restB.mul(sinTw)))
      const bendSlope = vec3(angles.x, 0.0, angles.y).mul(1.68 * 4.8 / 4.5).mul(pow(max(s, 1e-3), 0.68))
      const defT = normalize(restT.add(bendSlope))
      const defN = normalize(twistedN.sub(defT.mul(dot(twistedN, defT))))

      rachisDynamicRW.element(tid).assign(vec4(baseP.add(rel).add(swayOffset), restP.w))
      rachisDynamicRW.element(tid.add(RACHIS_NORMAL_OFFSET)).assign(vec4(defN, restN.w))
    })().computeKernel([RACHIS_NODES])
    rachisKernel.dispatchSize = [1, 1, 1]
    this.rachisStepCompute = rachisKernel

    // Layer 1: 128 Connected Stems + Variable Barbule-Envelope Steric Collisions (7 storage buffers <= 8 WebGPU limit!)
    // Velocities are position-based: each substep stores (p_end - p_start) / dt, with collision pushes scaled by
    // `contactBounce`. The frame slot of `stemAux` (rewritten by the Bishop transport at the end) holds each node's
    // start-of-substep velocity in between, for the acceleration the barbules whip from.
    const stemsKernel = Fn(() => {
      const wgStations = sharedArray('vec4', TOTAL_STATIONS)
      // Rest-pose stations (xyz): contacts measure compression from the rest distance, not from zero
      const wgRestStations = sharedArray('vec4', TOTAL_STATIONS)
      const barbIdx = int(localId.x)
      const baseNode = barbIdx.mul(STEM_NODES)

      const rootInfo = barbMeta.element(barbIdx)
      const styleInfo = barbMeta.element(barbIdx.add(BARB_STYLE_OFFSET))
      const rachisS = rootInfo.x
      const barbLen = rootInfo.z
      const segLen = barbLen.div(float(STEM_NODES - 1))
      const side = styleInfo.x
      const stiffScale = styleInfo.z.mul(stemStiffness)

      const rScaled = clamp(rachisS, 0.0, 0.9999).mul(float(RACHIS_NODES - 1))
      const r0 = minInt(int(rScaled), RACHIS_NODES - 2)
      const rf = rScaled.sub(float(r0))
      const rp0 = rachisDynamicRO.element(r0)
      const rp1 = rachisDynamicRO.element(r0.add(1))
      const sockPos = mix(rp0.xyz, rp1.xyz, rf)
      const rpPrev = rachisDynamicRO.element(maxInt(r0.sub(1), 0)).xyz
      const rpNext = rachisDynamicRO.element(minInt(r0.add(2), RACHIS_NODES - 1)).xyz
      const sockT = normalize(rp1.xyz.sub(rp0.xyz).mul(0.7).add(rpNext.sub(rpPrev).mul(0.3)))
      const rn0 = rachisDynamicRO.element(r0.add(RACHIS_NORMAL_OFFSET)).xyz
      const rn1 = rachisDynamicRO.element(r0.add(RACHIS_NORMAL_OFFSET + 1)).xyz
      const sockNRaw = mix(rn0, rn1, rf)
      const sockN = normalize(sockNRaw.sub(sockT.mul(dot(sockNRaw, sockT))))
      const sockB = normalize(cross(sockT, sockN))

      const restTargetAt = (jNode: Node<'int'>) => {
        const loc = stemLocalRest.element(baseNode.add(jNode))
        return vec4(
          sockPos.add(sockT.mul(loc.x)).add(sockN.mul(loc.y)).add(sockB.mul(loc.z)),
          loc.w,
        )
      }

      // Weld root node j = 0 rigidly to its rachis socket
      const rootRest = restTargetAt(int(0))
      const prevRootPos = stemPosRW.element(baseNode).xyz
      const rootVel = rootRest.xyz.sub(prevRootPos).div(max(dt, 1e-4)).toVar()
      stemPosRW.element(baseNode).assign(rootRest)
      stemVelRW.element(baseNode).assign(vec4(rootVel, stemVelRW.element(baseNode).w))

      // Pass 1A: Aerodynamic Stokes exponential drag + elastic shape restoration + inextensible forward rod solve
      const rootTorqueSum = vec3(0.0).toVar()
      Loop(STEM_NODES - 1, ({i}) => {
        const j = i.add(1)
        const nIdx = baseNode.add(j)
        const s = float(j).div(float(STEM_NODES - 1))

        const cur = stemPosRW.element(nIdx)
        const velData = stemVelRW.element(nIdx)
        const pOld = cur.xyz.toVar()
        const vOld = velData.xyz.toVar()
        const coreR = velData.w.toVar()
        const envR = cur.w
        const target = restTargetAt(j).xyz
        const parentPos = stemPosRW.element(nIdx.sub(1)).xyz

        const segVec = pOld.sub(parentPos)
        const tang = normalize(select(dot(segVec, segVec).greaterThan(1e-8), segVec, target.sub(parentPos)))

        const uAir = evalFeatherAirVelocity(pOld, phase, airStrength, thermalLift)
          .add(evalGestureField(pOld, gOrigin, gDir, gVel, gStrength, gRadius))

        const gammaPerp = float(10.0).add(envR.mul(48.0))
        const gammaPar = gammaPerp.mul(0.16)
        // Structural damping: flapping relative to the socket decays; the feather's common motion does not
        const vDamped = rootVel.add(vOld.sub(rootVel).mul(exp(stemDamping.negate().mul(dt))))
        const vPar = tang.mul(dot(vDamped, tang))
        const vPerp = vDamped.sub(vPar)
        const uPar = tang.mul(dot(uAir, tang))
        const uPerp = uAir.sub(uPar)

        const vNextDrag = uPar.add(vPar.sub(uPar).mul(exp(gammaPar.negate().mul(dt))))
          .add(uPerp.add(vPerp.sub(uPerp).mul(exp(gammaPerp.negate().mul(dt)))))

        const bendStiff = mix(float(92.0), float(9.5), pow(s, 0.78)).mul(stiffScale)
        const gravityWhisper = vec3(0.0, -0.32, 0.0)
        const elasticPull = target.sub(pOld)
        const vElastic = vNextDrag.add(elasticPull.mul(bendStiff).add(gravityWhisper).mul(dt))
        const pPred = pOld.add(vElastic.mul(dt))

        const socketClamp = smoothstep(0.22, 0.0, s).mul(0.45)
        const blendedPred = mix(pPred, target, socketClamp)
        const dirFromParent = normalize(blendedPred.sub(parentPos))
        const pSolved = parentPos.add(dirFromParent.mul(segLen)).toVar()

        stemPosRW.element(nIdx).assign(vec4(pSolved, envR))
        stemVelRW.element(nIdx).assign(vec4(pSolved.sub(pOld).div(dt), coreR))
        stemAuxRW.element(nIdx).assign(vec4(vOld, 0.0))

        const leverArm = pSolved.sub(sockPos)
        const fluidForce = uAir.sub(vOld).mul(envR.add(0.04))
        rootTorqueSum.addAssign(vec3(fluidForce.x, fluidForce.z, cross(leverArm, fluidForce).z.mul(0.35)))
      })

      capsulesAndTorqueRW.element(barbIdx.add(BARB_TORQUE_OFFSET)).assign(vec4(rootTorqueSum, side))

      wgStations.element(barbIdx.mul(4).add(0)).assign(stemPosRW.element(baseNode.add(4)))
      wgStations.element(barbIdx.mul(4).add(1)).assign(stemPosRW.element(baseNode.add(9)))
      wgStations.element(barbIdx.mul(4).add(2)).assign(stemPosRW.element(baseNode.add(14)))
      wgStations.element(barbIdx.mul(4).add(3)).assign(stemPosRW.element(baseNode.add(19)))
      wgRestStations.element(barbIdx.mul(4).add(0)).assign(restTargetAt(int(4)))
      wgRestStations.element(barbIdx.mul(4).add(1)).assign(restTargetAt(int(9)))
      wgRestStations.element(barbIdx.mul(4).add(2)).assign(restTargetAt(int(14)))
      wgRestStations.element(barbIdx.mul(4).add(3)).assign(restTargetAt(int(19)))

      workgroupBarrier()

      // Pass 1B: Variable Barbule-Envelope Stem–Stem Collisions
      const myMid = wgStations.element(barbIdx.mul(4).add(2)).xyz
      const prevParentPos = stemPosRW.element(baseNode.add(2)).xyz.toVar()

      Loop(STEM_NODES - 3, ({i}) => {
        const j = i.add(3)
        const nIdx = baseNode.add(j)
        const curNode = stemPosRW.element(nIdx)
        // Read before this node's position and velocity are overwritten below
        const curPos = curNode.xyz.toVar()
        const freeVel = stemVelRW.element(nIdx).xyz.toVar()
        const pos = curPos.toVar()
        const envR = curNode.w
        const coreR = stemVelRW.element(nIdx).w
        const myRest = restTargetAt(j).xyz
        const push = vec3(0.0).toVar()
        const maxPush = float(0.0).toVar()
        const contactAccum = vec3(0.0).toVar()
        const compPeak = float(0.0).toVar()

        If(envR.greaterThan(0.008), () => {
          Loop(BARB_COUNT, ({i: otherBarb}) => {
            If(otherBarb.notEqual(barbIdx), () => {
              const otherBase = otherBarb.mul(4)
              const otherMid = wgStations.element(otherBase.add(2)).xyz
              const midDelta = pos.sub(otherMid)
              If(dot(midDelta, midDelta).lessThan(6.8), () => {
                Loop(3, ({i: seg}) => {
                  const stA = wgStations.element(otherBase.add(seg))
                  const stB = wgStations.element(otherBase.add(seg.add(1)))
                  const ab = stB.xyz.sub(stA.xyz)
                  const abLenSq = max(dot(ab, ab), 1e-6)
                  const t = clamp(dot(pos.sub(stA.xyz), ab).div(abLenSq), 0.0, 1.0)
                  const closest = stA.xyz.add(ab.mul(t))
                  const otherEnvR = mix(stA.w, stB.w, t)
                  const sumEnv = envR.add(otherEnvR).mul(envCompliance)
                  // Barbs crowded into each other at rest only resist being pressed closer than that
                  const restClosest = mix(wgRestStations.element(otherBase.add(seg)).xyz, wgRestStations.element(otherBase.add(seg.add(1))).xyz, t)
                  const restDist = length(myRest.sub(restClosest))
                  const radius = min(sumEnv, mix(sumEnv, restDist, restOverlap))

                  const diff = pos.sub(closest)
                  const distSq = dot(diff, diff)
                  If(distSq.lessThan(radius.mul(radius)).and(radius.greaterThan(0.004)), () => {
                    const dist = sqrt(max(distSq, 1e-8))
                    const pushDir = diff.div(dist)
                    const overlap = float(1.0).sub(dist.div(radius))
                    // Spongy envelope: zero force at first touch, stiffening with compression
                    const softPush = radius.sub(dist).mul(overlap).mul(contactStiffness)
                    const coreFloor = max(min(coreR.add(0.004), radius).sub(dist), 0.0).mul(0.85)
                    const pushMag = softPush.add(coreFloor)
                    push.addAssign(pushDir.mul(pushMag))
                    maxPush.assign(max(maxPush, pushMag))

                    contactAccum.addAssign(pushDir.mul(overlap))
                    compPeak.assign(max(compPeak, overlap))
                  })
                })
              })
            })
          })
        })

        // Many overlapping neighbors in the dense core: their pushes add up, so cap the sum at the largest single one
        const pushLen = length(push)
        pos.addAssign(push.mul(min(float(1.0), min(maxPush, 0.045).div(max(pushLen, 1e-6)))))

        const reprojected = prevParentPos.add(normalize(pos.sub(prevParentPos)).mul(segLen))
        prevParentPos.assign(reprojected)

        // Velocity: the substep's free motion (stored by pass 1A), plus the inextensibility follow-through, plus only
        // `contactBounce` of the collision push, then velcro damping toward the socket's motion while compressed
        const pushCorrection = pos.sub(curPos)
        const totalCorrection = reprojected.sub(curPos)
        const correctionVel = totalCorrection.sub(pushCorrection.mul(float(1.0).sub(contactBounce))).div(max(dt, 1e-4))
        const contactVel = freeVel.add(correctionVel)
        const newVel = rootVel.add(contactVel.sub(rootVel).mul(exp(contactDamping.mul(compPeak).negate().mul(dt))))

        const startVel = stemAuxRW.element(nIdx).xyz
        const accel = newVel.sub(startVel).div(max(dt, 1e-4))
        const maxAcc = float(45.0)
        const safeAccel = accel.div(sqrt(float(1.0).add(dot(accel, accel).div(maxAcc.mul(maxAcc)))))
        const prevAccel = stemAuxRW.element(nIdx.add(STEM_ACCEL_OFFSET)).xyz
        const smoothAccel = mix(prevAccel, safeAccel, float(1.0).sub(exp(dt.mul(-40.0))))

        stemPosRW.element(nIdx).assign(vec4(reprojected, envR))
        stemVelRW.element(nIdx).assign(vec4(newVel, coreR))
        stemAuxRW.element(nIdx.add(STEM_ACCEL_OFFSET)).assign(vec4(smoothAccel, 0.0))

        const prevContact = stemAuxRW.element(nIdx.add(STEM_CONTACT_OFFSET))
        const nextContact = mix(prevContact, vec4(contactAccum, compPeak), clamp(dt.mul(16.0), 0.05, 0.45))
        stemAuxRW.element(nIdx.add(STEM_CONTACT_OFFSET)).assign(nextContact)
      })

      // Nodes 1 and 2 sit in the socket's clamp zone: no contacts, no barbule whip
      Loop(2, ({i}) => {
        const nIdx = baseNode.add(i.add(1))
        stemAuxRW.element(nIdx.add(STEM_ACCEL_OFFSET)).assign(vec4(0.0))
        stemAuxRW.element(nIdx.add(STEM_CONTACT_OFFSET)).assign(vec4(0.0))
      })

      const dihedralBias = styleInfo.y
      const initN = normalize(sockN.mul(cos(dihedralBias)).add(sockB.mul(sin(dihedralBias).mul(0.38))))
      const prevT = normalize(stemPosRW.element(baseNode.add(1)).xyz.sub(stemPosRW.element(baseNode).xyz)).toVar()
      const curN = normalize(initN.sub(prevT.mul(dot(initN, prevT)))).toVar()
      stemAuxRW.element(baseNode).assign(vec4(curN, myMid.z))

      Loop(STEM_NODES - 1, ({i}) => {
        const j = i.add(1)
        const nIdx = baseNode.add(j)
        const pPrev = stemPosRW.element(nIdx.sub(1)).xyz
        const pNext = stemPosRW.element(minInt(nIdx.add(1), baseNode.add(STEM_NODES - 1))).xyz
        const tNow = normalize(pNext.sub(pPrev))
        const transported = curN.sub(tNow.mul(dot(curN, tNow)))
        curN.assign(normalize(select(dot(transported, transported).greaterThan(1e-6), transported, sockN)))
        prevT.assign(tNow)
        stemAuxRW.element(nIdx).assign(vec4(curN, 0.0))
      })

      const capBaseA = barbIdx.mul(CAPSULES_PER_BARB)
      const capBaseB = capBaseA.add(CAPSULE_B_OFFSET)
      const n0 = stemPosRW.element(baseNode.add(1))
      const n6 = stemPosRW.element(baseNode.add(6))
      const n13 = stemPosRW.element(baseNode.add(13))
      const n19 = stemPosRW.element(baseNode.add(19))
      capsulesAndTorqueRW.element(capBaseA.add(0)).assign(n0)
      capsulesAndTorqueRW.element(capBaseB.add(0)).assign(n6)
      capsulesAndTorqueRW.element(capBaseA.add(1)).assign(n6)
      capsulesAndTorqueRW.element(capBaseB.add(1)).assign(n13)
      capsulesAndTorqueRW.element(capBaseA.add(2)).assign(n13)
      capsulesAndTorqueRW.element(capBaseB.add(2)).assign(n19)
    })().computeKernel([BARB_COUNT])
    stemsKernel.dispatchSize = [1, 1, 1]
    this.stemsStepCompute = stemsKernel

    // Layer 2: Microscopic Barbules — 2-Mode Cantilever Wave Dynamics + Envelope Splay + Shared-Memory Steric Ordering (6 storage buffers)
    const groupsPerSide = Math.max(1, Math.floor(barbulesPerSide / WORKGROUP_BARBULES))
    const totalBarbuleWorkgroups = BARB_COUNT * 2 * groupsPerSide

    const barbulesKernel = Fn(() => {
      const wgQ1 = sharedArray('vec2', WORKGROUP_BARBULES)

      const wgId = int(workgroupId.x)
      const lid = int(localId.x)
      const gIdx = int(instanceIndex)

      const groupInBarb = wgId.mod(groupsPerSide * 2)
      const barbIdx = wgId.div(groupsPerSide * 2)
      const sideIdx = groupInBarb.div(groupsPerSide)
      const chunkIdx = groupInBarb.mod(groupsPerSide)
      const vaneSide = select(sideIdx.equal(0), float(1.0), float(-1.0))
      const indexAlongVane = chunkIdx.mul(WORKGROUP_BARBULES).add(lid)

      const s = clamp(
        float(indexAlongVane).add(0.5).div(float(barbulesPerSide)).mul(0.965).add(0.022),
        0.02,
        0.992,
      )

      const rootInfo = barbMeta.element(barbIdx)
      const maxBarbuleLen = rootInfo.y

      const baseNode = barbIdx.mul(STEM_NODES)
      const sScaled = s.mul(float(STEM_NODES - 1))
      const j0 = minInt(int(sScaled), STEM_NODES - 2)
      const jf = sScaled.sub(float(j0))
      const n0 = baseNode.add(j0)
      const n1 = n0.add(1)

      const sp0 = stemPosRO.element(n0)
      const sp1 = stemPosRO.element(n1)
      const stemP = mix(sp0.xyz, sp1.xyz, jf)

      const spPrev = stemPosRO.element(maxInt(n0.sub(1), baseNode)).xyz
      const spNext = stemPosRO.element(minInt(n1.add(1), baseNode.add(STEM_NODES - 1))).xyz
      const stemT = normalize(sp1.xyz.sub(sp0.xyz).mul(0.65).add(spNext.sub(spPrev).mul(0.35)))
      const snRaw = mix(stemAuxRO.element(n0).xyz, stemAuxRO.element(n1).xyz, jf)
      const stemN = normalize(snRaw.sub(stemT.mul(dot(snRaw, stemT))))
      const stemB = normalize(cross(stemT, stemN))

      const stemV = mix(stemVelRO.element(n0).xyz, stemVelRO.element(n1).xyz, jf)
      const stemA = mix(stemAuxRO.element(n0.add(STEM_ACCEL_OFFSET)).xyz, stemAuxRO.element(n1.add(STEM_ACCEL_OFFSET)).xyz, jf)
      const contactVec = mix(stemAuxRO.element(n0.add(STEM_CONTACT_OFFSET)), stemAuxRO.element(n1.add(STEM_CONTACT_OFFSET)), jf)

      const hSeed = float(gIdx).mul(1.731)
      const h1 = hash(hSeed)
      const h2 = hash(hSeed.add(19.3))
      const h3 = hash(hSeed.add(47.7))

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

      const midWorld = stemP.add(restDir.mul(barbuleLen.mul(0.62)))
      const uAir = evalFeatherAirVelocity(midWorld, phase, airStrength, thermalLift).mul(barbuleWave)
        .add(evalGestureField(midWorld, gOrigin, gDir, gVel, gStrength, gRadius).mul(1.25))

      const relAir = uAir.sub(stemV)
      const ciliaWave = sin(s.mul(16.0).sub(phase.mul(4.0)).add(float(barbIdx).mul(0.37))).mul(0.055)
        .mul(airStrength).mul(barbuleWave)
      const airDrive = vec2(
        dot(relAir, eSweep).mul(0.42).add(ciliaWave),
        dot(relAir, eLift).mul(0.38).add(ciliaWave.mul(0.45)),
      )

      const inertialWhip = vec2(dot(stemA, eSweep), dot(stemA, eLift)).mul(-0.0085)

      const inwardPress = max(dot(contactVec.xyz, outwardB.negate()), 0.0)
      const lateralRub = dot(contactVec.xyz, eLift)
      const contactDrive = vec2(
        inwardPress.mul(0.42).add(dot(contactVec.xyz, eSweep).mul(0.25)),
        lateralRub.mul(0.38),
      )

      const curState = barbuleState.element(gIdx)
      const curVel = barbuleVel.element(gIdx)
      const q1 = curState.xy.toVar()
      const q2 = curState.zw.toVar()
      const v1 = curVel.xy.toVar()
      const v2 = curVel.zw.toVar()

      const invLenScale = clamp(float(0.36).div(max(barbuleLen, 0.05)), 0.7, 2.4)
      const omega1Sq = float(54.0).mul(invLenScale)
      const omega2Sq = float(195.0).mul(invLenScale)
      const damp1 = exp(dt.mul(barbuleDamping).mul(-8.5))
      const damp2 = exp(dt.mul(barbuleDamping).mul(-13.5))

      const targetQ1 = airDrive.add(inertialWhip).add(contactDrive)
      const targetQ2 = airDrive.mul(0.45).add(inertialWhip.mul(1.35)).sub(v1.mul(0.04))

      const acc1 = targetQ1.sub(q1).mul(omega1Sq)
      const acc2 = targetQ2.sub(q2).mul(omega2Sq)

      v1.assign(v1.add(acc1.mul(dt)).mul(damp1))
      v2.assign(v2.add(acc2.mul(dt)).mul(damp2))
      q1.addAssign(v1.mul(dt))
      q2.addAssign(v2.mul(dt))

      wgQ1.element(lid).assign(q1)
      workgroupBarrier()

      const leftLid = maxInt(lid.sub(1), 0)
      const rightLid = minInt(lid.add(1), WORKGROUP_BARBULES - 1)
      const qLeft = wgQ1.element(leftLid)
      const qRight = wgQ1.element(rightLid)

      const neighborAvg = qLeft.add(qRight).mul(0.5)
      q1.assign(mix(q1, neighborAvg, 0.12))

      const maxCrossing = float(0.085)
      const crossLeft = qLeft.x.sub(q1.x).sub(maxCrossing)
      const samePlaneLeft = smoothstep(0.24, 0.04, abs(qLeft.y.sub(q1.y)))
      If(lid.greaterThan(0).and(crossLeft.greaterThan(0.0)), () => {
        q1.x.addAssign(crossLeft.mul(0.42).mul(samePlaneLeft))
      })
      const crossRight = q1.x.sub(qRight.x).sub(maxCrossing)
      const samePlaneRight = smoothstep(0.24, 0.04, abs(q1.y.sub(qRight.y)))
      If(lid.lessThan(WORKGROUP_BARBULES - 1).and(crossRight.greaterThan(0.0)), () => {
        q1.x.subAssign(crossRight.mul(0.42).mul(samePlaneRight))
      })

      const limitQ1 = float(0.62)
      const limitQ2 = float(0.32)
      const q1Clamped = q1.div(sqrt(float(1.0).add(dot(q1, q1).div(limitQ1.mul(limitQ1)))))
      const q2Clamped = q2.div(sqrt(float(1.0).add(dot(q2, q2).div(limitQ2.mul(limitQ2)))))

      barbuleState.element(gIdx).assign(vec4(q1Clamped, q2Clamped))
      barbuleVel.element(gIdx).assign(vec4(v1, v2))
    })().computeKernel([WORKGROUP_BARBULES])
    barbulesKernel.dispatchSize = [totalBarbuleWorkgroups, 1, 1]
    this.barbulesStepCompute = barbulesKernel

    // GPU Back-to-Front Parallel Enumeration Sort (2 storage buffers, 1 barrier)
    const sortKernel = Fn(() => {
      const wgDepths = sharedArray('float', BARB_COUNT)
      const tid = int(localId.x)

      const baseNode = tid.mul(STEM_NODES)
      const pMid = stemPosRO.element(baseNode.add(10)).xyz
      const pTip = stemPosRO.element(baseNode.add(17)).xyz
      const centroid = pMid.mul(0.65).add(pTip.mul(0.35))
      const myDepth = dot(centroid.sub(camPos), camFwd)

      wgDepths.element(tid).assign(myDepth)
      workgroupBarrier()

      const rank = int(0).toVar()
      Loop(BARB_COUNT, ({i}) => {
        const otherDepth = wgDepths.element(i)
        const farther = otherDepth.greaterThan(myDepth)
          .or(otherDepth.equal(myDepth).and(i.lessThan(tid)))
        If(farther, () => {
          rank.addAssign(1)
        })
      })

      sortedBarbIndices.element(rank).assign(tid)
    })().computeKernel([BARB_COUNT])
    sortKernel.dispatchSize = [1, 1, 1]
    this.sortBarbsCompute = sortKernel
  }

  applyMorphology(morphology: FeatherMorphologyData, renderer?: WebGPURenderer) {
    this.rachisRestBuffer.array.set(packRachisRest(morphology))
    this.rachisDynamicBuffer.array.set(packRachisDynamic(morphology))
    this.barbMetaBuffer.array.set(packBarbMeta(morphology))
    this.stemLocalRestBuffer.array.set(morphology.stemLocalRest)
    this.stemPosBuffer.array.set(morphology.initialStemPos)
    this.stemVelBuffer.array.set(morphology.initialStemVel)
    this.stemAuxBuffer.array.set(packStemAux(morphology))
    ;(this.capsulesAndTorqueBuffer.array as Float32Array).fill(0)

    this.rachisRestBuffer.needsUpdate = true
    this.rachisDynamicBuffer.needsUpdate = true
    this.barbMetaBuffer.needsUpdate = true
    this.stemLocalRestBuffer.needsUpdate = true
    this.stemPosBuffer.needsUpdate = true
    this.stemVelBuffer.needsUpdate = true
    this.stemAuxBuffer.needsUpdate = true
    this.capsulesAndTorqueBuffer.needsUpdate = true

    if (renderer) void renderer.compute(this.resetCompute)
  }

  step(renderer: WebGPURenderer, deltaSeconds: number, phaseRadians: number, substeps = 2) {
    const clampedTotal = Math.min(Math.max(deltaSeconds, 1 / 480), 1 / 30)
    const steps = Math.max(1, substeps)
    this.dtUniform.value = clampedTotal / steps
    this.phaseUniform.value = phaseRadians
    for (let s = 0; s < steps; s++) {
      void renderer.compute(this.rachisStepCompute)
      void renderer.compute(this.stemsStepCompute)
    }
    this.dtUniform.value = clampedTotal
    void renderer.compute(this.barbulesStepCompute)
  }

  sortForCamera(renderer: WebGPURenderer, camera: Camera) {
    camera.getWorldPosition(this.cameraPosUniform.value)
    camera.getWorldDirection(this.cameraForwardUniform.value)
    void renderer.compute(this.sortBarbsCompute)
  }

  dispose() {
    this.resetCompute.dispose()
    this.rachisStepCompute.dispose()
    this.stemsStepCompute.dispose()
    this.barbulesStepCompute.dispose()
    this.sortBarbsCompute.dispose()
  }
}
