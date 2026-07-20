// Cars: one 3D model per driver.
//
// Primary path: a CC0 low-poly glTF (Kenney) if bundled in public/assets.
// Fallback: a procedural low-poly F1 built from three.js primitives so the app
// always renders. Bodies are tinted with the team colour, each car carries a
// billboard acronym label, the selected car is highlighted, and cars orient
// along their velocity and fade out when telemetry drops (pits/garage).

import * as THREE from 'three';
import { inProgressLap } from '../data/timing.js';
import { fmtLiveLap } from '../util/format.js';

const CAR_SCALE = 3.2; // scene units for car length-ish
// Above this zoomed-out frustum size, hide the ticking lap time to reduce
// clutter (acronym stays).
const LAPTIME_HIDE_FRUSTUM = 320;
let sharedGLTF = null; // loaded template, if any

export class CarManager {
  constructor(renderer, store, transform) {
    this.renderer = renderer;
    this.store = store;
    this.transform = transform;
    this.cars = new Map(); // driver_number -> { group, bodyMats, label, ring, targetHeading }
    this.selected = null;
    this.group = new THREE.Group();
    this.group.name = 'cars';
    renderer.add(this.group);
    this._raycaster = new THREE.Raycaster();
  }

  // Dispose all car geometries/materials/textures (session switch).
  dispose() {
    for (const car of this.cars.values()) {
      car.group.traverse((o) => {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (m && m.map && m.map.dispose) m.map.dispose();
            if (m && m.dispose) m.dispose();
          }
        }
      });
    }
    this.cars.clear();
    this.renderer.remove(this.group);
  }

  static async tryLoadGLTF(url) {
    try {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      sharedGLTF = await new Promise((res, rej) => loader.load(url, res, undefined, rej));
      return true;
    } catch (e) {
      sharedGLTF = null;
      return false;
    }
  }

  ensureCar(num) {
    let car = this.cars.get(num);
    if (car) return car;
    const color = new THREE.Color(this.store.teamColour(num));
    const built = sharedGLTF ? buildCarFromGLTF(color) : buildCar(color);
    const label = makeLabel(this.store.acronym(num), this.store.teamColour(num));
    label.position.set(0, 6.5, 0);
    built.group.add(label);
    built.group.visible = false;
    built.group.userData.driverNumber = num; // for raycast picking
    this.group.add(built.group);
    car = {
      ...built, label, num, alpha: 1, lastHeading: 0,
      cur: new THREE.Vector3(), tgt: new THREE.Vector3(), inited: false,
      labelText: '', wheelSpin: 0,
    };
    this.cars.set(num, car);
    return car;
  }

  setSelected(num) {
    this.selected = num;
    for (const [n, car] of this.cars) {
      if (car.ring) car.ring.visible = n === num;
    }
  }

  // Update all cars for session time T given a Map(num -> {x,y,z,heading,alpha,present}).
  // `tMs` is used for the ticking floating lap-time label.
  update(samples, dt, tMs) {
    const zoom = this.renderer.frustumSize || 260;
    // Scale labels so they stay a roughly constant on-screen size as the camera
    // zooms; hide the lap time when zoomed far out to avoid clutter.
    const labelScale = clamp(zoom / 260, 0.7, 2.4);
    const showLapTime = zoom < LAPTIME_HIDE_FRUSTUM;

    for (const [num, s] of samples) {
      const car = this.ensureCar(num);
      const scene = this.transform.toScene(s.x, s.y);
      car.tgt.set(scene.x, 0, scene.z);
      if (!car.inited) { car.cur.copy(car.tgt); car.inited = true; }
      const moved = car.cur.distanceTo(car.tgt);
      car.cur.lerp(car.tgt, 0.5);
      car.group.position.copy(car.cur);

      // Heading: OpenF1 world (x,y) → scene (x,z); scene heading = atan2(dz,dx).
      let h = -s.heading + Math.PI / 2; // align model's +Z forward
      car.lastHeading = lerpAngle(car.lastHeading, h, 0.35);
      car.group.rotation.y = car.lastHeading;

      // Fade
      const targetAlpha = s.alpha == null ? 1 : s.alpha;
      car.alpha += (targetAlpha - car.alpha) * 0.2;
      car.group.visible = car.alpha > 0.02;
      setOpacity(car, car.alpha);

      // Wheels spin proportional to recent movement.
      if (car.wheels && car.wheels.length) {
        car.wheelSpin += moved * 0.5;
        for (const w of car.wheels) w.rotation.x = car.wheelSpin;
      }

      // Floating label: acronym + live current-lap time.
      const sel = num === this.selected;
      const ls = (sel ? 1.25 : 1) * labelScale;
      car.label.scale.set(6 * ls, 3.75 * ls, 1);
      let timeStr = '';
      if (showLapTime && tMs != null) {
        const lap = inProgressLap(this.store.laps, num, tMs);
        if (lap && lap.date_start) {
          const ms = tMs - Date.parse(lap.date_start);
          if (ms >= 0 && ms < 600000) timeStr = fmtLiveLap(ms);
        }
      }
      const wanted = `${this.store.acronym(num)}|${timeStr}`;
      if (wanted !== car.labelText) {
        car.labelText = wanted;
        car.label.userData.redraw(this.store.acronym(num), timeStr);
      }
    }
    // Hide cars with no sample this frame.
    for (const [num, car] of this.cars) {
      if (!samples.has(num)) car.group.visible = false;
    }
  }

  // Raycast a normalized device coord (x,y in [-1,1]) against cars; returns the
  // driver_number of the nearest hit (car body or its label) or null.
  pick(ndc, camera) {
    this._raycaster.setFromCamera(ndc, camera);
    const hits = this._raycaster.intersectObjects(this.group.children, true);
    for (const hit of hits) {
      let o = hit.object;
      while (o) {
        if (o.userData && o.userData.driverNumber != null) {
          const car = this.cars.get(o.userData.driverNumber);
          if (car && car.group.visible) return o.userData.driverNumber;
        }
        o = o.parent;
      }
    }
    return null;
  }

  selectedWorldPos() {
    if (this.selected == null) return null;
    const car = this.cars.get(this.selected);
    return car && car.group.visible ? car.group.position.clone() : null;
  }
}

function setOpacity(car, a) {
  for (const m of car.allMats) {
    m.transparent = a < 0.99;
    m.opacity = a;
  }
  if (car.label && car.label.material) car.label.material.opacity = a;
  if (car.ring && car.ring.material) car.ring.material.opacity = a * 0.9;
}

// Invisible-but-raycastable click proxy: at track-wide zoom a car body is only
// ~15 px on screen (and moving), so picking the exact geometry is near
// impossible. The proxy gives each car a generous, stable hit cylinder without
// drawing anything (colorWrite/depthWrite off ⇒ no pixels, no depth impact).
function makeHitProxy() {
  const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const hit = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 8, 8), mat);
  hit.position.y = 3;
  hit.name = 'hit-proxy';
  return hit;
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// --- procedural low-poly F1 -------------------------------------------------

function buildCar(teamColor) {
  const group = new THREE.Group();
  const allMats = [];
  const bodyMat = new THREE.MeshStandardMaterial({ color: teamColor, roughness: 0.45, metalness: 0.25 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.6, metalness: 0.1 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.5 });
  allMats.push(bodyMat, darkMat, accentMat);

  const L = CAR_SCALE;

  // Main body (tapered box)
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.55, L * 1.6), bodyMat);
  body.position.y = 0.55;
  body.castShadow = true;
  group.add(body);

  // Nose cone
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.42, L * 1.1, 8), bodyMat);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.5, L * 1.35);
  nose.castShadow = true;
  group.add(nose);

  // Cockpit / airbox
  const airbox = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.6, 0.9), darkMat);
  airbox.position.set(0, 0.95, -L * 0.2);
  airbox.castShadow = true;
  group.add(airbox);

  // Halo
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.07, 8, 16, Math.PI), darkMat);
  halo.rotation.x = Math.PI / 2;
  halo.rotation.z = Math.PI;
  halo.position.set(0, 1.1, L * 0.15);
  group.add(halo);

  // Front wing
  const fw = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.1, 0.7), accentMat);
  fw.position.set(0, 0.28, L * 1.7);
  fw.castShadow = true;
  group.add(fw);

  // Rear wing
  const rwPlane = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.6, 0.12), bodyMat);
  rwPlane.position.set(0, 1.25, -L * 1.35);
  rwPlane.castShadow = true;
  group.add(rwPlane);
  const rwEndL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.7, 0.6), darkMat);
  rwEndL.position.set(0.85, 1.2, -L * 1.3); group.add(rwEndL);
  const rwEndR = rwEndL.clone(); rwEndR.position.x = -0.85; group.add(rwEndR);

  // Wheels
  const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.45, 14);
  const wheels = [];
  const wheelPos = [
    [0.95, 0.5, L * 1.0],
    [-0.95, 0.5, L * 1.0],
    [0.95, 0.5, -L * 0.9],
    [-0.95, 0.5, -L * 0.9],
  ];
  for (const [x, y, z] of wheelPos) {
    const w = new THREE.Mesh(wheelGeo, darkMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, y, z);
    w.castShadow = true;
    group.add(w);
    wheels.push(w);
  }

  // Selection ring
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.4, 3.0, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.12;
  ring.visible = false;
  group.add(ring);

  group.add(makeHitProxy());

  group.scale.setScalar(1.1);
  return { group, bodyMat, allMats, wheels, ring };
}

// Build a car from the loaded CC0 glTF template (used only if a glb is bundled).
// The body is tinted with the team colour; a selection ring is added to match
// the procedural car's interface.
function buildCarFromGLTF(teamColor) {
  const group = new THREE.Group();
  const allMats = [];
  const model = sharedGLTF.scene.clone(true);
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      const mat = o.material.clone();
      // Tint the largest/body-like materials; keep dark parts dark.
      if (mat.color) {
        const l = mat.color.getHSL({}).l;
        if (l > 0.18) mat.color.copy(teamColor);
      }
      o.material = mat;
      allMats.push(mat);
    }
  });
  // Normalize scale to roughly match the procedural car footprint.
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = (CAR_SCALE * 3.2) / maxDim;
  model.scale.setScalar(s);
  const center = box.getCenter(new THREE.Vector3()).multiplyScalar(s);
  model.position.set(-center.x, 0, -center.z);
  group.add(model);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.4, 3.0, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.12;
  ring.visible = false;
  group.add(ring);
  group.add(makeHitProxy());
  return { group, bodyMat: allMats[0], allMats, wheels: [], ring };
}

// --- billboard label sprite -------------------------------------------------

function makeLabel(text, colorHex) {
  const canvas = document.createElement('canvas');
  const W = 256, H = 160;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(6, 3.75, 1);

  // Redraw acronym (+ optional live lap time on a second line).
  const redraw = (acr, timeStr) => {
    ctx.clearRect(0, 0, W, H);
    const pad = 12;
    const boxH = timeStr ? 116 : 78;
    roundRect(ctx, pad, 18, W - pad * 2, boxH, 18);
    ctx.fillStyle = 'rgba(10,14,20,0.82)';
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = colorHex;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 54px "Arial Narrow", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(acr, W / 2, timeStr ? 52 : 57);
    if (timeStr) {
      ctx.fillStyle = '#8fe3ff';
      ctx.font = '600 40px "Arial Narrow", Arial, sans-serif';
      ctx.fillText(timeStr, W / 2, 100);
    }
    tex.needsUpdate = true;
  };
  redraw(text, '');
  sprite.userData.redraw = redraw;
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
