/**
 * Thin accent frame drawn around a flat interactable (screen, monitor,
 * whiteboard, nameplate). Built from the mesh's local bounding box and world
 * transform, so it never touches the target's own material (no wash-out of
 * emissive / RTT / GUI screens, unlike an effect-layer highlight).
 */
import {
  Color3,
  CreateBox,
  Matrix,
  Mesh,
  PBRMaterial,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
  type AbstractMesh,
} from "@/engine/babylon";

const MARGIN = 0.025;
const THICK = 0.01;

export class FocusFrame {
  private readonly root: TransformNode;
  private readonly bars: Mesh[] = [];
  private readonly mat: PBRMaterial;
  private target: AbstractMesh | null = null;

  constructor(scene: Scene, color = "#F5C9A8") {
    this.root = new TransformNode("focusFrame", scene);
    this.mat = new PBRMaterial("focusFrame:mat", scene);
    this.mat.albedoColor = Color3.Black();
    this.mat.emissiveColor = Color3.FromHexString(color).toLinearSpace();
    this.mat.emissiveIntensity = 1.6;
    this.mat.disableLighting = true;
    this.mat.environmentIntensity = 0;
    for (let i = 0; i < 4; i++) {
      const b = CreateBox(`focusFrame:${i}`, { size: 1 }, scene);
      b.parent = this.root;
      b.material = this.mat;
      b.isPickable = false;
      b.receiveShadows = false;
      this.bars.push(b);
    }
    this.root.setEnabled(false);
  }

  show(mesh: AbstractMesh | null): void {
    this.target = mesh;
    if (!mesh) {
      this.root.setEnabled(false);
      return;
    }
    this.refresh();
    this.root.setEnabled(true);
  }

  /** Re-fit to the target (call on probe ticks; targets are mostly static). */
  refresh(): void {
    const mesh = this.target;
    if (!mesh || mesh.isDisposed()) {
      this.root.setEnabled(false);
      return;
    }
    const bb = mesh.getBoundingInfo().boundingBox;
    const min = bb.minimum;
    const max = bb.maximum;
    const ext = max.subtract(min);
    const centre = min.add(max).scale(0.5);
    const scale = new Vector3();
    const rot = new Quaternion();
    const pos = new Vector3();
    const wm: Matrix = mesh.computeWorldMatrix(true);
    wm.decompose(scale, rot, pos);
    this.root.position.copyFrom(Vector3.TransformCoordinates(centre, wm));
    this.root.rotationQuaternion = rot;
    this.root.scaling.setAll(1);
    // World-size extents per local axis; the smallest axis is the normal.
    const e = [
      Math.abs(ext.x * scale.x),
      Math.abs(ext.y * scale.y),
      Math.abs(ext.z * scale.z),
    ];
    const order = [0, 1, 2].sort((a, b) => e[b] - e[a]);
    const [ia, ib, inorm] = order;
    const wa = e[ia] + MARGIN * 2;
    const wb = e[ib] + MARGIN * 2;
    const depth = e[inorm] + 0.006;
    const setBar = (
      bar: Mesh,
      along: number,
      alongLen: number,
      across: number,
      offset: number,
    ) => {
      const s = [0, 0, 0];
      s[along] = alongLen + THICK;
      s[across] = THICK;
      s[inorm] = depth;
      bar.scaling.set(s[0], s[1], s[2]);
      const p = [0, 0, 0];
      p[across] = offset;
      bar.position.set(p[0], p[1], p[2]);
    };
    setBar(this.bars[0], ia, wa, ib, wb / 2);
    setBar(this.bars[1], ia, wa, ib, -wb / 2);
    setBar(this.bars[2], ib, wb, ia, wa / 2);
    setBar(this.bars[3], ib, wb, ia, -wa / 2);
  }

  dispose(): void {
    this.root.dispose(false, false);
    this.mat.dispose();
  }
}
