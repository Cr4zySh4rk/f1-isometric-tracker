// Empirical probe of the real click→select→follow pipeline, using the REAL
// IsoRenderer and CarManager; only THREE.WebGLRenderer is mocked (no GPU in
// node). DOM is faked with a minimal event-capable canvas.
//
// This suite PROVES the follow-feature root cause and its fix:
//  - Root cause: focusDriver used to snapshot selectedWorldPos() at click time
//    and setFollow(null) when the car had no sample yet, latching follow OFF
//    (the main loop's refresh was gated on followEnabled). The renderer also
//    killed follow on EVERY pointerdown, including the click that selects.
//  - Fix: setFollow accepts a FUNCTION (intent) resolved every frame in
//    renderer.update(); follow engages when the car appears, survives sample
//    gaps, and is broken only by a real pan drag (with onFollowBreak).
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal();
  class FakeWebGLRenderer {
    constructor() { this.shadowMap = {}; }
    setPixelRatio() {}
    setSize() {}
    setClearColor() {}
    render(scene, camera) { scene.updateMatrixWorld(); camera.updateMatrixWorld(); }
  }
  return { ...three, WebGLRenderer: FakeWebGLRenderer };
});

function fakeCanvas(w = 1280, h = 800) {
  const listeners = new Map(); // type -> [fn]
  return {
    clientWidth: w, clientHeight: h, width: w, height: h,
    style: {},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: w, height: h }; },
    dispatch(type, ev) {
      for (const fn of listeners.get(type) || []) fn(ev);
    },
    getContext(kind) {
      if (kind === '2d') return fake2d();
      return {};
    },
  };
}

function fake2d() {
  return new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return null;
      return () => {};
    },
    set() { return true; },
  });
}

beforeAll(() => {
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
    WebGLRenderingContext: function () {},
  };
  globalThis.document = {
    createElement: (tag) => (tag === 'canvas' ? fakeCanvas(256, 160) : { style: {} }),
    getElementById: () => null,
  };
});

async function setup() {
  const THREE = await import('three');
  const { IsoRenderer } = await import('../src/scene/renderer.js');
  const { CarManager } = await import('../src/scene/cars.js');
  const canvas = fakeCanvas();
  const r = new IsoRenderer(canvas);

  // Track ~200x160 units centered near origin.
  const centerline = [];
  for (let i = 0; i < 100; i++) {
    const a = (i / 100) * Math.PI * 2;
    centerline.push(new THREE.Vector2(Math.cos(a) * 100, Math.sin(a) * 80));
  }
  r.frameTrack(centerline);

  const store = { teamColour: () => '#3671c6', acronym: () => 'VER', laps: [] };
  const transform = { toScene: (x, y) => ({ x: x / 10, z: y / 10 }) };
  const carMgr = new CarManager(r, store, transform);
  return { THREE, canvas, r, carMgr };
}

// Project a scene point to client px on the fake canvas.
function toClient(r, canvas, scenePos) {
  const proj = scenePos.clone().project(r.camera);
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((proj.x + 1) / 2) * rect.width + rect.left,
    y: ((-proj.y + 1) / 2) * rect.height + rect.top,
  };
}

function ndcOf(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -((clientY - rect.top) / rect.height) * 2 + 1,
  };
}

// The main.js focusDriver glue after the fix: follow by intent function.
function focusGlue(r, carMgr, num) {
  carMgr.setSelected(num);
  r.setFollow(() => carMgr.selectedWorldPos());
}

describe('click → select → follow (real renderer + cars)', () => {
  it('raycast pick hits the car; a plain click does NOT break follow; camera converges on the car', async () => {
    const { canvas, r, carMgr } = await setup();
    const samples = new Map([[1, { x: 300, y: -200, heading: 0.4, alpha: 1 }]]);
    carMgr.update(samples, 16, Date.now());
    r.render();
    r.camera.updateMatrixWorld();
    r.camera.updateProjectionMatrix();

    const carPos = carMgr.cars.get(1).group.position.clone();
    expect(carPos.x).toBeCloseTo(30, 3);
    expect(carPos.z).toBeCloseTo(-20, 3);

    const { x: clientX, y: clientY } = toClient(r, canvas, carPos.clone().setY(0.6));

    // Full pointer sequence like a real click (renderer handlers run too).
    canvas.dispatch('pointerdown', { clientX, clientY, pointerId: 7 });
    canvas.dispatch('pointerup', { clientX, clientY, pointerId: 7 });

    // main.js pointerup glue: pick + focus.
    const num = carMgr.pick(ndcOf(canvas, clientX, clientY), r.camera);
    expect(num).toBe(1);
    focusGlue(r, carMgr, num);
    expect(r.followEnabled).toBe(true);

    // Simulate frames — no per-frame refresh glue needed anymore.
    for (let i = 0; i < 120; i++) r.update();
    expect(r.target.distanceTo(carPos)).toBeLessThan(0.5);

    // Camera keeps the iso offset: position - target parallel to offsetDir.
    const off = r.camera.position.clone().sub(r.target).normalize();
    expect(off.distanceTo(r.offsetDir)).toBeLessThan(1e-6);
  });

  it('generous hit proxy: a click ~12 px off the car body still picks it; far clicks miss', async () => {
    const { canvas, r, carMgr } = await setup();
    carMgr.update(new Map([[1, { x: 300, y: -200, heading: 0, alpha: 1 }]]), 16, Date.now());
    r.render();
    const carPos = carMgr.cars.get(1).group.position.clone();
    const { x, y } = toClient(r, canvas, carPos.clone().setY(0.6));

    for (const [dx, dy] of [[12, 0], [-12, 0], [0, 10], [8, 8]]) {
      expect(carMgr.pick(ndcOf(canvas, x + dx, y + dy), r.camera)).toBe(1);
    }
    expect(carMgr.pick(ndcOf(canvas, x + 120, y + 120), r.camera)).toBe(null);
  });

  it('FIXED latch: focusing while the car has no sample engages follow as soon as the car appears', async () => {
    const { r, carMgr } = await setup();

    // No samples yet (buffer still loading) → no car, no world position.
    focusGlue(r, carMgr, 44);
    expect(carMgr.selectedWorldPos()).toBe(null);
    expect(r.followEnabled).toBe(true); // intent survives unavailability

    const before = r.target.clone();
    r.update(); // resolves to null → camera holds, follow stays engaged
    expect(r.followEnabled).toBe(true);
    expect(r.target.distanceTo(before)).toBe(0);

    // Later the car appears — follow re-acquires with NO extra user action.
    carMgr.update(new Map([[44, { x: 100, y: 100, heading: 0, alpha: 1 }]]), 16, Date.now());
    const carPos = carMgr.cars.get(44).group.position.clone();
    for (let i = 0; i < 120; i++) r.update();
    expect(r.followEnabled).toBe(true);
    expect(r.target.distanceTo(carPos)).toBeLessThan(0.5);
  });

  it('manual pan (real drag) disengages follow + fires onFollowBreak; re-clicking re-engages', async () => {
    const { canvas, r, carMgr } = await setup();
    carMgr.update(new Map([[1, { x: 300, y: -200, heading: 0, alpha: 1 }]]), 16, Date.now());
    r.render();
    focusGlue(r, carMgr, 1);
    expect(r.followEnabled).toBe(true);

    let broke = 0;
    r.onFollowBreak = () => broke++;

    // Drag: pointerdown + move well beyond the 5 px jitter threshold.
    canvas.dispatch('pointerdown', { clientX: 400, clientY: 400, pointerId: 3 });
    expect(r.followEnabled).toBe(true); // pointerdown alone must NOT break follow
    canvas.dispatch('pointermove', { clientX: 430, clientY: 415, pointerId: 3 });
    canvas.dispatch('pointerup', { clientX: 430, clientY: 415, pointerId: 3 });
    expect(r.followEnabled).toBe(false);
    expect(broke).toBe(1);

    // Re-click the car → follow re-engages.
    const carPos = carMgr.cars.get(1).group.position.clone();
    const { x, y } = toClient(r, canvas, carPos.clone().setY(0.6));
    canvas.dispatch('pointerdown', { clientX: x, clientY: y, pointerId: 4 });
    canvas.dispatch('pointerup', { clientX: x, clientY: y, pointerId: 4 });
    const num = carMgr.pick(ndcOf(canvas, x, y), r.camera);
    expect(num).toBe(1);
    focusGlue(r, carMgr, num);
    expect(r.followEnabled).toBe(true);
    for (let i = 0; i < 120; i++) r.update();
    expect(r.target.distanceTo(carPos)).toBeLessThan(0.5);
  });

  it('two-finger pinch zoom does not disengage follow', async () => {
    const { canvas, r, carMgr } = await setup();
    carMgr.update(new Map([[1, { x: 300, y: -200, heading: 0, alpha: 1 }]]), 16, Date.now());
    r.render();
    focusGlue(r, carMgr, 1);

    canvas.dispatch('pointerdown', { clientX: 500, clientY: 400, pointerId: 10 });
    canvas.dispatch('pointerdown', { clientX: 700, clientY: 400, pointerId: 11 });
    canvas.dispatch('pointermove', { clientX: 480, clientY: 400, pointerId: 10 });
    canvas.dispatch('pointermove', { clientX: 720, clientY: 400, pointerId: 11 });
    canvas.dispatch('pointerup', { clientX: 480, clientY: 400, pointerId: 10 });
    canvas.dispatch('pointerup', { clientX: 720, clientY: 400, pointerId: 11 });
    expect(r.followEnabled).toBe(true);
  });

  it('follow survives a sample gap (car fades out and back) without re-clicking', async () => {
    const { r, carMgr } = await setup();
    carMgr.update(new Map([[1, { x: 300, y: -200, heading: 0, alpha: 1 }]]), 16, Date.now());
    focusGlue(r, carMgr, 1);
    for (let i = 0; i < 60; i++) r.update();

    // Gap: no sample for this driver → car hidden, selectedWorldPos() null.
    carMgr.update(new Map(), 16, Date.now());
    expect(carMgr.selectedWorldPos()).toBe(null);
    r.update();
    expect(r.followEnabled).toBe(true); // still engaged

    // Car returns elsewhere on track — camera converges again.
    for (let i = 0; i < 200; i++) {
      carMgr.update(new Map([[1, { x: -400, y: 500, heading: 1, alpha: 1 }]]), 16, Date.now());
      r.update();
    }
    const back = carMgr.cars.get(1).group.position.clone();
    expect(back.x).toBeCloseTo(-40, 3);
    expect(back.z).toBeCloseTo(50, 3);
    expect(r.target.distanceTo(back)).toBeLessThan(0.5);
  });
});
