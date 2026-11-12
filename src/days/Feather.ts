import { BoxGeometry, Color, Mesh, MeshBasicMaterial, PerspectiveCamera } from 'three/webgpu'
import { Register } from '@io-gui/core'
import { Document, DocumentProps } from '@io-gui/three'

/** Codevember day 12. Stand-in until the piece is built. */
@Register
export class Feather extends Document {

  constructor(args?: DocumentProps) {
    super(args)

    const camera = new PerspectiveCamera(50, 1, 0.1, 100)
    camera.name = 'Camera'
    camera.position.set(1.8, 1.2, 2.4)
    camera.lookAt(0, 0, 0)
    this.activeCamera = camera

    this.scene.background = new Color().setHSL(11 / 30, 0.12, 0.08)

    const mesh = new Mesh(
      new BoxGeometry(),
      new MeshBasicMaterial({color: new Color().setHSL(11 / 30, 0.55, 0.55)}),
    )
    mesh.name = 'Feather'
    this.scene.add(mesh)
  }
}
