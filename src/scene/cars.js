// Cars: one 3D model per driver.
//
// Primary path: a CC0 low-poly glTF (Kenney) if bundled in public/assets.
// Fallback: a procedural low-poly F1 built from three.js primitives so the app
// always renders. Bodies are tinted with the team colour, each car carries a
// billboard acronym label, the selected car is highlighted, and cars orient
// along their velocity and fade out when telemetry drops (pits/garage).

import * as THREE from 'three';

const CAR_SCALE = 3.2; // scene units for car length-ish
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
    this.group.add(built.group);
    car = { ...built, label, num, alpha: 1, lastHeading: 0, cur: new THREE.Vector3(), tgt: new THREE.Vector3(), inited: false };
    this.cars.set(num, car);
    return car;
  }

  setSelected(num) {
    this.selected = num;
    for (const [n, car] of this.cars) {
      const on = n === num;
      if (car.ring) car.ring.visible = on;
      if (car.label.material.map) car.label.scale.setScalar(on ? 1.25 : 1);
    }
  }

  // Update all cars for session time T given a Map(num -> {x,y,z,heading,alpha,present}).
  update(samples, dt) {
    for (const [num, s] of samples) {
      const car = this.ensureCar(num);
      const scene = this.transform.toScene(s.x, s.y);
      car.tgt.set(scene.x, 0, scene.z);
      if (!car.inited) { car.cur.copy(car.tgt); car.inited = true; }
      // Smooth follow (interp already smooth; this just damps snaps on seek).
      car.cur.lerp(car.tgt, 0.5);
      car.group.position.copy(car.cur);

      // Heading: OpenF1 world (x,y) → scene (x,z); scene heading = atan2(dz,dx).
      // world heading is atan2(dy,dx); z maps from y so sign preserved.
      let h = -s.heading + Math.PI / 2; // align model's +Z forward
      // Smooth the heading (shortest angular path).
      car.lastHeading = lerpAngle(car.lastHeading, h, 0.35);
      car.group.rotation.y = car.lastHeading;

      // Fade
      const targetAlpha = s.alpha == null ? 1 : s.alpha;
      car.alpha += (targetAlpha - car.alpha) * 0.2;
      const visible = car.alpha > 0.02;
      car.group.visible = visible;
      setOpacity(car, car.alpha);

      // wheels spin proportional to recent movement
      const speed = car.cur.distanceTo(car.tgt);
    }
    // Hide cars with no sample this frame.
    for (const [num, car] of this.cars) {
      if (!samples.has(num)) car.group.visible = false;
    }
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

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

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
  return { group, bodyMat: allMats[0], allMats, wheels: [], ring };
}

// --- billboard label sprite -------------------------------------------------

function makeLabel(text, colorHex) {
  const canvas = document.createElement('canvas');
  const S = 256;
  canvas.width = S; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, S, 128);
  // pill background
  const pad = 12;
  roundRect(ctx, pad, 24, S - pad * 2, 80, 18);
  ctx.fillStyle = 'rgba(10,14,20,0.82)';
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = colorHex;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 58px "Arial Narrow", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, S / 2, 66);

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(6, 3, 1);
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
