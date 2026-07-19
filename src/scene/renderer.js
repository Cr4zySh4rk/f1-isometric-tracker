// three.js scene with a classic isometric orthographic camera.
//
// Camera attitude: 45° yaw, ~35.264° pitch (true isometric). Zoom changes the
// orthographic frustum size; pan slides the look-at target across the ground
// plane while preserving the isometric angle. "Follow" eases the target toward
// a tracked world position.

import * as THREE from 'three';

const ISO_YAW = Math.PI / 4; // 45°
const ISO_PITCH = Math.atan(1 / Math.SQRT2); // ~35.264°

export class IsoRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x0a0e14, 1);

    this.scene = new THREE.Scene();

    // Camera offset direction (unit) from the iso angles.
    this.offsetDir = new THREE.Vector3(
      Math.cos(ISO_PITCH) * Math.sin(ISO_YAW),
      Math.sin(ISO_PITCH),
      Math.cos(ISO_PITCH) * Math.cos(ISO_YAW)
    );
    this.camDistance = 400;
    this.frustumSize = 260; // world units visible vertically (zoom)
    this.target = new THREE.Vector3(0, 0, 0);
    this.followTarget = null; // Vector3 or null
    this.followEnabled = false;

    const aspect = this._aspect();
    this.camera = new THREE.OrthographicCamera(
      (-this.frustumSize * aspect) / 2,
      (this.frustumSize * aspect) / 2,
      this.frustumSize / 2,
      -this.frustumSize / 2,
      -2000,
      4000
    );
    this._placeCamera();

    this._buildEnvironment();

    // Ground + sky
    this._buildGround();

    this.dirLight = null;
    this._buildLights();

    // Interaction state
    this._initInput();

    this._resizeObserver = null;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  _aspect() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    return w / h;
  }

  _buildEnvironment() {
    // Subtle gradient sky as a large background sphere (rendered behind).
    const skyGeo = new THREE.SphereGeometry(3000, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(0x1b2740) },
        bottom: { value: new THREE.Color(0x090c12) },
      },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vP; uniform vec3 top; uniform vec3 bottom;
        void main(){ float h = clamp((normalize(vP).y*0.5)+0.5,0.0,1.0); gl_FragColor = vec4(mix(bottom, top, h),1.0); }`,
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.frustumCulled = false;
    this.scene.add(sky);
    this.scene.fog = new THREE.Fog(0x0a0e14, 500, 1600);
  }

  _buildGround() {
    const geo = new THREE.PlaneGeometry(2400, 2400);
    const mat = new THREE.MeshStandardMaterial({ color: 0x11151c, roughness: 1, metalness: 0 });
    const ground = new THREE.Mesh(geo, mat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.scene.add(ground);

    const grid = new THREE.GridHelper(2400, 96, 0x203040, 0x161c26);
    grid.position.y = 0;
    grid.material.opacity = 0.35;
    grid.material.transparent = true;
    this.scene.add(grid);
    this.grid = grid;
  }

  _buildLights() {
    const amb = new THREE.HemisphereLight(0xbfd4ff, 0x1a1f2a, 0.75);
    this.scene.add(amb);

    const dir = new THREE.DirectionalLight(0xfff2d8, 1.35);
    dir.position.set(180, 320, 140);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    const d = 320;
    dir.shadow.camera.left = -d;
    dir.shadow.camera.right = d;
    dir.shadow.camera.top = d;
    dir.shadow.camera.bottom = -d;
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 1200;
    dir.shadow.bias = -0.0005;
    dir.shadow.normalBias = 0.5;
    this.scene.add(dir);
    this.scene.add(dir.target);
    this.dirLight = dir;

    const rim = new THREE.DirectionalLight(0x4466aa, 0.4);
    rim.position.set(-200, 120, -180);
    this.scene.add(rim);
  }

  // Tint the key light for flag states (yellow / red edge lighting).
  setFlagTint(kind) {
    if (!this.dirLight) return;
    if (kind === 'YELLOW' || kind === 'DOUBLE YELLOW' || kind === 'SC' || kind === 'VSC') {
      this.dirLight.color.set(0xffd24a);
    } else if (kind === 'RED') {
      this.dirLight.color.set(0xff5a4a);
    } else {
      this.dirLight.color.set(0xfff2d8);
    }
  }

  _placeCamera() {
    const eye = this.target.clone().add(this.offsetDir.clone().multiplyScalar(this.camDistance));
    this.camera.position.copy(eye);
    this.camera.lookAt(this.target);
    this.dirLight && this.dirLight.target && this.dirLight.target.position.copy(this.target);
  }

  add(obj) { this.scene.add(obj); }
  remove(obj) { this.scene.remove(obj); }

  setFollow(worldVec3OrNull) {
    this.followTarget = worldVec3OrNull;
    this.followEnabled = !!worldVec3OrNull;
  }

  frameTrack(centerlineVec2) {
    if (!centerlineVec2 || !centerlineVec2.length) return;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of centerlineVec2) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minZ) minZ = p.y;
      if (p.y > maxZ) maxZ = p.y;
    }
    this.target.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    const extent = Math.max(maxX - minX, maxZ - minZ, 60);
    this.frustumSize = extent * 1.35;
    this._applyZoom();
    this._placeCamera();
  }

  _applyZoom() {
    const aspect = this._aspect();
    this.camera.left = (-this.frustumSize * aspect) / 2;
    this.camera.right = (this.frustumSize * aspect) / 2;
    this.camera.top = this.frustumSize / 2;
    this.camera.bottom = -this.frustumSize / 2;
    this.camera.updateProjectionMatrix();
  }

  // --- input: wheel zoom, drag pan, pinch ---
  _initInput() {
    const el = this.canvas;
    let dragging = false;
    let lastX = 0, lastY = 0;

    const worldRight = new THREE.Vector3();
    const worldForward = new THREE.Vector3();

    const updateBasis = () => {
      // Screen-right and screen-"down" projected onto ground plane.
      worldRight.set(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0);
      // Derive from camera orientation.
      this.camera.updateMatrixWorld();
      const r = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const u = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      r.y = 0; r.normalize();
      u.y = 0; u.normalize();
      worldRight.copy(r);
      worldForward.copy(u);
    };

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.0011);
      this.frustumSize = clamp(this.frustumSize * factor, 30, 900);
      this._applyZoom();
    }, { passive: false });

    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      this.followEnabled = false; // manual pan breaks follow
      lastX = e.clientX; lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
      updateBasis();
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      const worldPerPx = this.frustumSize / (this.canvas.clientHeight || 1);
      const move = new THREE.Vector3()
        .addScaledVector(worldRight, -dx * worldPerPx)
        .addScaledVector(worldForward, dy * worldPerPx);
      this.target.add(move);
      this._placeCamera();
    });
    const end = (e) => { dragging = false; try { el.releasePointerCapture(e.pointerId); } catch {} };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    // Pinch zoom (two-pointer) — track active pointers.
    this._pointers = new Map();
    el.addEventListener('pointerdown', (e) => this._pointers.set(e.pointerId, e));
    el.addEventListener('pointermove', (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      this._pointers.set(e.pointerId, e);
      if (this._pointers.size === 2) {
        const [a, b] = [...this._pointers.values()];
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (this._lastPinch) {
          const factor = this._lastPinch / dist;
          this.frustumSize = clamp(this.frustumSize * factor, 30, 900);
          this._applyZoom();
        }
        this._lastPinch = dist;
        dragging = false;
      }
    });
    const clearP = (e) => { this._pointers.delete(e.pointerId); if (this._pointers.size < 2) this._lastPinch = null; };
    el.addEventListener('pointerup', clearP);
    el.addEventListener('pointercancel', clearP);
  }

  update() {
    if (this.followEnabled && this.followTarget) {
      this.target.lerp(this.followTarget, 0.12);
      this._placeCamera();
    }
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this._applyZoom();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}
