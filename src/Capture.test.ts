import { describe, it, expect } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three/webgpu'
import { goldenStride, irisSample, setThinLensViewOffset } from './Capture.js'

/** The camera io's views draw through a scene camera: its frame fitted inside a `width × height` picture (`View`). */
function fitted(camera: PerspectiveCamera, width: number, height: number) {
  const view = camera.clone()
  const aspect = width / height
  view.fov = 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * Math.max(1, camera.aspect / aspect)) * 180 / Math.PI
  view.aspect = aspect
  view.updateProjectionMatrix()
  view.updateMatrixWorld()
  return view
}

describe('Capture lens', () => {

  it('holds the plane in focus still across the aperture, in a picture of another aspect than the camera', () => {
    const width = 4096
    const height = 1716
    const focusDistance = 5.65
    const center = new PerspectiveCamera(18, 2.39, 0.25, 120)
    center.position.set(0.42, -0.18, 5.65)
    center.lookAt(0.42, -0.18, 0)
    center.updateMatrixWorld()
    const centerView = fitted(center, width, height)

    const right = new Vector3(1, 0, 0).applyQuaternion(center.quaternion)
    const up = new Vector3(0, 1, 0).applyQuaternion(center.quaternion)
    const forward = new Vector3(0, 0, -1).applyQuaternion(center.quaternion)
    const ahead = (depth: number, x: number, y: number) =>
      center.position.clone().addScaledVector(forward, depth).addScaledVector(right, x).addScaledVector(up, y)
    const inFocus = [ahead(focusDistance, 0, 0), ahead(focusDistance, -1.35, 0.62), ahead(focusDistance, 1.85, -0.54)]
    const behind = ahead(7.5, 0.3, 0.2)

    const shifted = center.clone()
    const a = new Vector3()
    const b = new Vector3()
    for (let i = 0; i < 64; i++) {
      const iris = irisSample(i, 64, 9, 0.65)
      const dx = iris.x * 0.19
      const dy = iris.y * 0.19
      shifted.position.copy(center.position).addScaledVector(right, dx).addScaledVector(up, dy)
      setThinLensViewOffset(shifted, dx, dy, focusDistance, width, height)
      expect(shifted.aspect).toBe(2.39)
      shifted.updateMatrixWorld()
      const shiftedView = fitted(shifted, width, height)
      for (const point of inFocus) {
        a.copy(point).project(centerView)
        b.copy(point).project(shiftedView)
        // within a thousandth of a pixel
        expect(Math.abs(b.x - a.x) * width / 2).toBeLessThan(1e-3)
        expect(Math.abs(b.y - a.y) * height / 2).toBeLessThan(1e-3)
      }
      // through a thin lens a point at depth z moves (z - focus) / z of the lens's move, at the plane in focus
      a.copy(behind).project(centerView)
      b.copy(behind).project(shiftedView)
      const halfHeight = focusDistance * Math.tan(centerView.fov * Math.PI / 360)
      const move = (7.5 - focusDistance) / 7.5
      expect((b.x - a.x) * halfHeight * centerView.aspect).toBeCloseTo(dx * move, 6)
      expect((b.y - a.y) * halfHeight).toBeCloseTo(dy * move, 6)
    }
  })

  it('moves the picture by the jitter alone at the middle of the aperture', () => {
    const camera = new PerspectiveCamera(18, 2.39, 0.25, 120)
    camera.position.set(0, 0, 5)
    camera.updateMatrixWorld()
    const point = new Vector3(0.7, -0.4, 0)
    const a = point.clone().project(fitted(camera, 4096, 1716))
    setThinLensViewOffset(camera, 0, 0, 5, 4096, 1716, 0.25, -0.375)
    const b = point.clone().project(fitted(camera, 4096, 1716))
    // a jitter moves the frame right and down (here right 0.25 px and up 0.375 px): what it shows moves the other way
    expect((b.x - a.x) * 4096 / 2).toBeCloseTo(-0.25, 9)
    expect((b.y - a.y) * 1716 / 2).toBeCloseTo(-0.375, 9)
  })

  it('spreads the lens samples evenly inside the iris', () => {
    const count = 64
    const points = Array.from({length: count}, (_, i) => irisSample(i, count, 9, 0.65))
    let x = 0
    let y = 0
    for (const point of points) {
      expect(Math.hypot(point.x, point.y)).toBeLessThanOrEqual(1)
      x += point.x / count
      y += point.y / count
    }
    expect(Math.hypot(x, y)).toBeLessThan(0.02)
    // each point's nearest neighbor about as far as in a hexagonal packing of the disc
    const spacing = Math.sqrt(2 * Math.PI / (Math.sqrt(3) * count))
    for (const point of points) {
      const nearest = Math.min(...points.filter(other => other !== point).map(other => Math.hypot(other.x - point.x, other.y - point.y)))
      expect(nearest / spacing).toBeGreaterThan(0.6)
      expect(nearest / spacing).toBeLessThan(1.4)
    }
  })

  it('visits every lens sample once, whatever their number', () => {
    for (const count of [1, 2, 3, 7, 16, 32, 64, 100, 128, 256]) {
      const stride = goldenStride(count)
      const visited = new Set(Array.from({length: count}, (_, i) => i * stride % count))
      expect(visited.size).toBe(count)
    }
  })
})
