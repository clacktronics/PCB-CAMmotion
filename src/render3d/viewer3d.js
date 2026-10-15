// 3D board view: the stackup as textured layers in real colours, plated hole barrels and the
// board edge. Orbit (left drag), pan (right drag or shift+drag), zoom (wheel, towards the
// cursor), and an exploded view that spreads the layers apart. Browser only (WebGL, three.js).

import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  Group,
  Mesh,
  InstancedMesh,
  PlaneGeometry,
  CylinderGeometry,
  BufferGeometry,
  BufferAttribute,
  MeshStandardMaterial,
  PMREMGenerator,
  CanvasTexture,
  AmbientLight,
  DirectionalLight,
  Color,
  Matrix4,
  Vector3,
  DoubleSide,
  SRGBColorSpace,
  LinearMipmapLinearFilter,
} from '../../vendor/three/three.module.js';
import { OrbitControls } from '../../vendor/three/OrbitControls.js';
import { RoomEnvironment } from '../../vendor/three/RoomEnvironment.js';
import { buildStack3d, explodeOffsets, explodeGapMm, drillHoles, edgeWalls } from '../model/stack3d.js';
import { boardArea } from '../render/board-render.js';
import { LayerPictures, pictureFrame, loopsBounds } from './layer-pictures.js';
import { backgroundColour } from '../model/view-modes.js';
import { SUBSTRATE, MISC, SURFACE, lookupMaterial } from '../model/materials.js';

const FOV_DEG = 35;
const MAX_INSTANCES = 50000;

export class Viewer3D {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onCamera?:(c:object)=>void, onError?:(message:string)=>void}} cb
   */
  constructor(canvas, cb = {}) {
    this.canvas = canvas;
    this.cb = cb;
    this.layers = [];
    this.settings = { stackup: {}, solo: [], showPaste: false, background: 'dark', explode: 0, side: 'top' };
    this.visible = false;
    this.needsScene = true;
    this.renderCount = 0;
    this.items = [];
    this.parts = []; // { item, mesh, face: 'z0'|'z1' } and walls
    this.holes = null;
    this.frame = null;
    this.gl = null;
    this.failed = null;
    this.savedCamera = null;
    this.raf = 0;
  }

  /** Create the WebGL renderer on first use. Returns false when WebGL is not available. */
  #init() {
    if (this.gl || this.failed) return !!this.gl;
    try {
      this.gl = new WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
    } catch (e) {
      this.failed = `3D view needs WebGL, which is not available here (${e.message})`;
      this.cb.onError?.(this.failed);
      return false;
    }
    this.gl.setPixelRatio(globalThis.devicePixelRatio || 1);
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(FOV_DEG, 1, 0.1, 10000);
    this.camera.up.set(0, 0, 1); // board in the XY plane, +Z towards the top side
    // a soft studio room (generated, nothing loaded) for metals to reflect
    const pmrem = new PMREMGenerator(this.gl);
    // given to each material (not scene.environment, which would override every material's
    // envMapIntensity: metals should reflect the room strongly, lacquer and FR4 hardly)
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.add(new AmbientLight(0xffffff, 0.4));
    const key = new DirectionalLight(0xffffff, 1.8);
    key.position.set(0.4, -0.6, 1);
    const under = new DirectionalLight(0xffffff, 1.0);
    under.position.set(-0.4, 0.6, -1);
    const side = new DirectionalLight(0xffffff, 0.5);
    side.position.set(1, 1, 0.2);
    this.scene.add(key, under, side);
    this.board = new Group();
    this.scene.add(this.board);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => this.requestRender());
    this.controls.addEventListener('end', () => this.cb.onCamera?.(this.getCamera()));
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    this.resize();
    return true;
  }

  show(on) {
    this.visible = on;
    this.canvas.classList.toggle('hidden', !on);
    if (!on || !this.#init()) return;
    this.resize();
    if (this.needsScene) this.#buildScene();
    this.requestRender();
  }

  setLayers(layers) {
    this.layers = layers;
    this.layersChanged();
  }

  layersChanged() {
    this.needsScene = true;
    if (this.visible && this.gl) {
      this.#buildScene();
      this.requestRender();
    }
  }

  setSettings(patch) {
    Object.assign(this.settings, patch);
    if ('stackup' in patch || 'solo' in patch || 'showPaste' in patch) return this.layersChanged();
    if (!this.gl) return;
    if ('explode' in patch) this.#placeItems();
    if ('side' in patch) this.fit();
    this.requestRender();
  }

  resize() {
    if (!this.gl) return;
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.gl.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender() {
    if (!this.gl || !this.visible || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.renderNow();
    });
  }

  renderNow() {
    if (!this.gl) return;
    this.scene.background = srgb(backgroundColour('realistic', this.settings.background));
    this.gl.render(this.scene, this.camera);
    this.renderCount++;
    this.canvas.dataset.renders = String(this.renderCount);
  }

  // ---------------------------------------------------------------- scene

  #clear() {
    for (const obj of [...this.board.children]) {
      this.board.remove(obj);
      obj.geometry?.dispose();
      obj.material?.map?.dispose();
      obj.material?.dispose();
    }
    this.parts = [];
    this.holes = null;
  }

  #buildScene() {
    this.needsScene = false;
    this.#clear();
    const layers = this.layers.filter((l) => l.image);
    const profile = layers.find((l) => l.role.type === 'profile');
    const loops = boardArea(layers, profile);
    const bounds = loops && loopsBounds(loops);
    this.items = [];
    this.frame = null;
    if (!bounds) return this.requestRender();
    const st = this.settings.stackup || {};
    const { items } = buildStack3d(layers, st, { showPaste: this.settings.showPaste });
    this.items = items;
    const maxTex = Math.min(4096, this.gl.capabilities.maxTextureSize || 2048);
    this.frame = pictureFrame(bounds, Math.min(maxTex, 3072));
    const pictures = new LayerPictures(layers, st, this.frame);
    const solo = this.settings.solo || [];
    const anisotropy = Math.min(8, this.gl.capabilities.getMaxAnisotropy());
    const [x0, y0, x1, y1] = bounds;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const plane = new PlaneGeometry(x1 - x0, y1 - y0);
    const sub = lookupMaterial('substrate', st.substrate).value || SUBSTRATE.fr4;

    for (const item of items) {
      if (item.layerId && solo.length && !solo.includes(item.layerId)) continue;
      const pic = pictures.picture(item);
      const tex = new CanvasTexture(pic.canvas);
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = anisotropy;
      tex.minFilter = LinearMipmapLinearFilter;
      const transparent = pic.opacity < 1;
      const mat = new MeshStandardMaterial({
        map: tex,
        side: DoubleSide,
        transparent,
        opacity: pic.opacity,
        alphaTest: transparent ? 0.02 : 0.5,
        depthWrite: !transparent,
        envMap: this.envMap,
        ...pic.surface,
      });
      // thin layers are drawn as one face: the outer face of the layer
      const faces = item.type === 'dielectric' ? ['z0', 'z1'] : [item.side === 'bottom' ? 'z0' : 'z1'];
      for (const [i, face] of faces.entries()) {
        const mesh = new Mesh(plane, i ? mat.clone() : mat);
        mesh.position.set(cx, cy, 0);
        mesh.name = item.id;
        this.board.add(mesh);
        this.parts.push({ item, mesh, face });
      }
      if (item.type === 'dielectric') {
        const walls = edgeWalls(loops, item.z0Mm, item.z1Mm);
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(walls.positions, 3));
        g.setAttribute('normal', new BufferAttribute(walls.normals, 3));
        const edge = new Mesh(
          g,
          new MeshStandardMaterial({
            color: srgb(sub.rgb, 0.8),
            side: DoubleSide,
            envMap: this.envMap,
            ...SURFACE.substrate,
          }),
        );
        edge.name = `${item.id}:edge`;
        this.board.add(edge);
        this.parts.push({ item, mesh: edge, face: 'walls' });
      }
    }
    pictures.dispose();
    this.#buildHoles(layers, sub);
    this.#placeItems();
    if (this.savedCamera) {
      this.setCamera(this.savedCamera);
      this.savedCamera = null;
    } else if (!this.hasCamera) this.fit();
    this.requestRender();
  }

  /** Hole walls: plated barrels (finish colour) and non-plated hole walls (substrate). */
  #buildHoles(layers, sub) {
    const holes = drillHoles(layers).slice(0, MAX_INSTANCES);
    if (!holes.length) return;
    const geo = new CylinderGeometry(0.5, 0.5, 1, 24, 1, true);
    geo.rotateX(Math.PI / 2); // axis along Z
    const finish = lookupMaterial('finish', this.settings.stackup?.finish).value;
    const make = (list, rgb, surface) => {
      if (!list.length) return null;
      const mesh = new InstancedMesh(
        geo,
        new MeshStandardMaterial({ color: srgb(rgb), side: DoubleSide, envMap: this.envMap, ...surface }),
        list.length,
      );
      mesh.userData.holes = list;
      this.board.add(mesh);
      return mesh;
    };
    this.holes = {
      plated: make(
        holes.filter((h) => h.plated),
        finish.rgb,
        SURFACE.copper,
      ),
      npth: make(
        holes.filter((h) => !h.plated),
        MISC.holeWall.rgb ?? sub.rgb,
        SURFACE.holeWall,
      ),
    };
  }

  /** Put every item at its Z for the current explode amount, and stretch the hole walls. */
  #placeItems() {
    if (!this.frame) return;
    const b = this.frame.bounds;
    const gap = explodeGapMm(b[2] - b[0], b[3] - b[1]);
    const dz = explodeOffsets(this.items, this.settings.explode, gap);
    for (const p of this.parts) {
      const off = dz.get(p.item.id) ?? 0;
      if (p.face === 'walls') p.mesh.position.z = off;
      else p.mesh.position.z = (p.face === 'z0' ? p.item.z0Mm : p.item.z1Mm) + off;
    }
    if (!this.holes) return;
    const span = (types) => {
      const list = this.items.filter((i) => types.includes(i.type));
      if (!list.length) return null;
      return [Math.min(...list.map((i) => i.z0Mm + dz.get(i.id))), Math.max(...list.map((i) => i.z1Mm + dz.get(i.id)))];
    };
    const plated = span(['copper', 'dielectric']);
    const bare = span(['dielectric']);
    const m = new Matrix4();
    for (const [mesh, z] of [
      [this.holes.plated, plated],
      [this.holes.npth, bare],
    ]) {
      if (!mesh || !z) continue;
      const len = Math.max(z[1] - z[0], 1e-3);
      mesh.userData.holes.forEach((h, i) => {
        m.makeScale(h.diaMm, h.diaMm, len);
        m.setPosition(h.x, h.y, (z[0] + z[1]) / 2);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  // ---------------------------------------------------------------- camera

  /** Frame the whole board, looking from the top or bottom side at an angle. */
  fit() {
    if (!this.gl || !this.frame) return;
    const b = this.frame.bounds;
    const size = Math.max(b[2] - b[0], b[3] - b[1], 1);
    const target = new Vector3((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 0);
    const dist = (size * 0.62) / Math.tan(((FOV_DEG / 2) * Math.PI) / 180);
    const dir = new Vector3(0.3, -0.9, this.settings.side === 'bottom' ? -0.85 : 0.85).normalize();
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.controls.target.copy(target);
    this.#clip(size);
    this.controls.update();
    this.hasCamera = true;
    this.requestRender();
    this.cb.onCamera?.(this.getCamera());
  }

  #clip(size) {
    this.camera.near = Math.max(0.01, size / 500);
    this.camera.far = size * 100;
    this.camera.updateProjectionMatrix();
  }

  /** Camera position and orbit target in mm (saved in the project). */
  getCamera() {
    if (!this.camera) return this.savedCamera;
    const r = (v) => Math.round(v * 1e4) / 1e4;
    return {
      position: this.camera.position.toArray().map(r),
      target: this.controls.target.toArray().map(r),
    };
  }

  setCamera(c) {
    const ok = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
    if (!c || !ok(c.position) || !ok(c.target)) return;
    if (!this.gl || !this.frame) {
      this.savedCamera = c;
      return;
    }
    this.camera.position.fromArray(c.position);
    this.controls.target.fromArray(c.target);
    const b = this.frame.bounds;
    this.#clip(Math.max(b[2] - b[0], b[3] - b[1], 1));
    this.controls.update();
    this.hasCamera = true;
    this.requestRender();
  }

  /** Forget the camera so the next scene is framed afresh (new board loaded). */
  resetCamera(saved = null) {
    this.hasCamera = false;
    this.savedCamera = saved;
  }

  /** For tests: what is in the scene and where. */
  state() {
    return {
      ready: !!this.gl && !this.needsScene,
      failed: this.failed,
      renders: this.renderCount,
      explode: this.settings.explode,
      items: this.parts
        .filter((p) => p.face !== 'walls')
        .map((p) => ({
          id: p.item.id,
          type: p.item.type,
          side: p.item.side,
          z: p.mesh.position.z,
          metalness: p.mesh.material.metalness,
          roughness: p.mesh.material.roughness,
        })),
      holes: {
        plated: this.holes?.plated?.count ?? 0,
        npth: this.holes?.npth?.count ?? 0,
        platedMetalness: this.holes?.plated?.material.metalness ?? null,
      },
      camera: this.getCamera(),
    };
  }
}

function srgb(rgb, k = 1) {
  return new Color().setRGB((rgb[0] / 255) * k, (rgb[1] / 255) * k, (rgb[2] / 255) * k, SRGBColorSpace);
}
