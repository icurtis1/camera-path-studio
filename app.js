import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import GUI from 'lil-gui';

// Camera Path Studio: draws an Atlas take's camera path over its video (the "Video" layout) or inside a
// point cloud of the scene ("3D scene"), and exports the result. Everything is drawn into one
// 1920×1080 canvas, so the preview and the export are the same pixels.

const W = 1920, H = 1080;
const SANS = 'Inter, system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, monospace';
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- settings --

// Everything in the side panel. Each layout overrides a few of these below.
const BASE = {
  // path
  showInset: true,                     // Video layout: the 3D path inset (off = just the video)
  pathColor: '#ffffff', pathWidth: 4, futureStyle: 'dotted', dashSize: 0.07, futureOpacity: 0.85,
  // cameras
  camColor: '#8ab4ff', camSize: 0.4, camImage: true,
  keyframes: 'off', keyEvery: 30, keyColor: '#8ab4ff', keySize: 0.22,
  inputCam: true, inputColor: '#f08c00', inputSize: 0.4,
  // view
  wiggle: 'off', wiggleAmount: 5, insetCorner: 'bottom-left', insetScale: 1, insetMargin: 0,
  // the output video and input photo beside the 3D scene
  showOutput: true, showInput: true, pipCorner: 'top-right', pipScale: 1,
  // video look
  gradeBrightness: 1, gradeContrast: 1, gradeSaturation: 1, vignette: 0, scrim: 0,
  // text
  showHud: false, title: 'Atlas', subtitle: 'Camera-controlled generation', showStats: true, showProgress: true, showLabels: true,
  // 3D scene
  bg3d: '#0d0e12', grid: true, gridY: 0, cloud: false, cloudSize: 0.012,
  // export
  exportName: '',
};
const LAYOUTS = {
  // the video full-frame, with the 3D path inset in a corner
  overlay: {
    pathWidth: 6, dashSize: 0.09, camSize: 0.55, keySize: 0.3, inputSize: 0.55, grid: false,
    gradeBrightness: 1.03, gradeContrast: 1.03, vignette: 0.42, scrim: 1,
  },
  // the path inside a point cloud of the scene, with the video picture-in-picture
  world: { cloud: true, keyframes: 'trail', wiggle: 'circle', showStats: false, showProgress: false },
};
// Fixed details of each layout's look (not in the side panel).
const FIXED = {
  overlay: { stageBg: '#000000', camWidth: 3.5, camFill: 0.1, shadow: 0.5, pathOnTop: true, transparent3d: true, fog: false, gridColor: '#ffffff', gridOpacity: 0.25 },
  world: { stageBg: '#0b0c10', camWidth: 2.5, camFill: 0.12, shadow: 0, pathOnTop: false, transparent3d: false, fog: true, gridColor: '#262a33', gridOpacity: 1 },
};
const fx = () => FIXED[layout];
const TEXT = '#ffffff', ACCENT = '#8ab4ff', UNIT = 'm';
const KEY_OPACITY = 0.6;                            // keyframe frustums sit back a little
const GHOST_OPACITY = 0.25;                         // path seen through a frame image
const VIGNETTE_SIZE = 0.55;
const SCRIM = { top: 0.31, topSize: 0.12, bottom: 0.56, bottomSize: 0.4 };   // edge shading at 1
const WIGGLE_PERIOD = 2.5;                          // seconds; exports fit a whole number of cycles
const CLOUD = { stride: 2, minConfidence: 0.3, maxDepth: 12 };
const GRID_CELL = 0.5;
const EXPORT_SS = 2;                                // 3D supersampling when exporting
// Where the 3D view starts on a take you haven't framed yet, as [side, up, forward] relative to the
// path's direction of travel ("path"), or to the input camera's heading for loops ("scene").
const START_ANGLES = {
  overlay: { path: [0.52, 0.29, -0.81], scene: [-0.05, 0.29, -0.96] },
  world: { path: [0.56, 0.24, -0.8], scene: [-0.02, 0.24, -0.97] },
};

// Settings and framing are remembered in the browser.
const STORE_KEY = 'camera-path-studio';
const store = (() => {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
})();
store.per ??= {};      // layout -> settings
store.views ??= {};    // take -> layout -> exact 3D view
store.angles ??= {};   // layout -> last view angle (applied to takes without a saved view)
let layout = LAYOUTS[store.layout] ? store.layout : 'overlay';
const S = {};
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.layout = layout;
    store.per[layout] = { ...S };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch {}
  }, 200);
}
function loadLayoutSettings(l) {
  for (const k of Object.keys(S)) delete S[k];
  Object.assign(S, BASE, LAYOUTS[l]);
  for (const [k, v] of Object.entries(store.per[l] || {})) if (k in BASE) S[k] = v;
}

// ------------------------------------------------------------------- utils --

const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const deg = (r) => THREE.MathUtils.radToDeg(r);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad = (n, w = 3) => String(n).padStart(w, '0');
const signed = (v, d = 2) => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(d);
const LIN = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function hexA(hex, a) {
  const c = new THREE.Color(hex);
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
}
function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`failed to load ${url}`));
    img.src = url;
  });
}
function pixels(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  return x.getImageData(0, 0, c.width, c.height).data;
}
const once = (el, ev) => new Promise((r) => el.addEventListener(ev, r, { once: true }));

// scene.json camera -> world pose (three.js uses the same right/up/back convention)
function camFrom(c) {
  const e = c.extrinsics, k = c.intrinsics;
  const quat = new THREE.Quaternion(...e.quaternion);
  if ((e.coordinateSystem || 'rub').toLowerCase() === 'rdf') quat.multiply(new THREE.Quaternion(1, 0, 0, 0));
  return {
    pos: v3(...e.position), quat,
    fx: k.fx, fy: k.fy, cx: k.cx, cy: k.cy, w: k.width, h: k.height,
    vfov: 2 * Math.atan(k.height / 2 / k.fy),
    hfov: 2 * Math.atan(k.width / 2 / k.fx),
  };
}

// ------------------------------------------------------------------- state --

let T = null;        // loaded take
let frame = 0;
let playing = false;
let exporting = false;
let ss = 1;          // supersampling factor for the 3D render
let overlayFrame = -1;

const stage = $('stage');
stage.width = W; stage.height = H;
const ctx = stage.getContext('2d');
const hit = $('hit');
const video = document.createElement('video');
video.muted = true; video.playsInline = true; video.loop = true;

// ------------------------------------------------------------------- three --

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const gl = renderer.domElement;
const scene3 = new THREE.Scene();
const fog = new THREE.Fog('#ffffff', 1, 10);
const cam3 = new THREE.PerspectiveCamera(35, 16 / 9, 0.01, 1000);
const viewCam = new THREE.PerspectiveCamera();   // cam3 + wiggle, used only for rendering
const controls = new OrbitControls(cam3, hit);
controls.enableDamping = true;
controls.dampingFactor = 0.15;
controls.addEventListener('end', () => saveView());
// the "drag to rotate" hint shows until the first time someone actually drags the view
controls.addEventListener('start', () => {
  if (!hit.classList.contains('teach')) return;
  hit.classList.remove('teach');
  store.orbitHintSeen = true;
  save();
});

const world = new THREE.Group();   // grid + point cloud
const ov = new THREE.Group();      // path, frustums (rebuilt on style changes)
scene3.add(world, ov);
let grid = null, cloud = null;
const lineMats = [];
const dotMats = [];
const O = {};                      // handles to overlay objects

const live = document.createElement('canvas');   // the current frame, shown in the moving frustum
live.width = 480; live.height = 270;
const liveCtx = live.getContext('2d');
const liveTex = new THREE.CanvasTexture(live);
liveTex.colorSpace = THREE.SRGBColorSpace;

const dotTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.beginPath(); x.arc(32, 32, 30, 0, Math.PI * 2); x.fill();
  return new THREE.CanvasTexture(c);
})();

const thumbs = new Map();          // frame index -> { tex, canvas, img, ready }
function thumb(i) {
  if (thumbs.has(i)) return thumbs.get(i).tex;
  const c = document.createElement('canvas');
  c.width = 320; c.height = 180;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const entry = { tex, canvas: c, img: null };
  entry.ready = frameImage(i).then((img) => {
    entry.img = img;
    gradedDraw(c.getContext('2d'), img, 0, 0, c.width, c.height);
    tex.needsUpdate = true;
  }).catch(() => {});
  thumbs.set(i, entry);
  return tex;
}
let inputTex = null;

// ------------------------------------------------------------------ layout --

function rects() {
  if (layout === 'overlay') {
    const w = Math.round(720 * S.insetScale), h = Math.round(480 * S.insetScale), m = S.insetMargin;
    const left = S.insetCorner.endsWith('left'), top = S.insetCorner.startsWith('top');
    return {
      output: { x: 0, y: 0, w: W, h: H },
      view: { x: left ? m : W - m - w, y: top ? m : H - m - h, w, h },
      statsLeft: !left,
    };
  }
  // 3D scene: the pictures stack from a corner (output above input), each with its label below
  const w = Math.round(544 * S.pipScale), h = Math.round(306 * S.pipScale), gap = 52, m = 40;
  const right = S.pipCorner.endsWith('right'), top = S.pipCorner.startsWith('top');
  const shown = [S.showOutput && 'output', S.showInput && 'input'].filter(Boolean);
  const out = { view: { x: 0, y: 0, w: W, h: H }, output: null, input: null, pipRight: right };
  let y = top ? m : H - m - 36 - h - (shown.length - 1) * (h + gap);
  for (const k of shown) {
    out[k] = { x: right ? W - m - w : m, y, w, h };
    y += h + gap;
  }
  return out;
}

function setRenderSize(factor) {
  ss = factor;
  const v = rects().view;
  renderer.setSize(Math.round(v.w * ss), Math.round(v.h * ss), false);
  cam3.aspect = v.w / v.h;
  cam3.updateProjectionMatrix();
  for (const m of lineMats) {
    m.linewidth = m.userData.w * ss;
    m.resolution.set(v.w * ss, v.h * ss);
  }
  for (const m of dotMats) m.size = m.userData.size * ss;
}

const show3D = () => layout !== 'overlay' || S.showInset;
function fitStage() {
  const vp = $('viewport');
  const s = Math.min((vp.clientWidth - 40) / W, (vp.clientHeight - 40) / H);
  const wrap = $('stageWrap');
  wrap.style.width = `${W * s}px`;
  wrap.style.height = `${H * s}px`;
  const v = rects().view;
  hit.hidden = !show3D();
  Object.assign(hit.style, {
    left: `${(v.x / W) * 100}%`, top: `${(v.y / H) * 100}%`,
    width: `${(v.w / W) * 100}%`, height: `${(v.h / H) * 100}%`,
  });
}
window.addEventListener('resize', fitStage);

// --------------------------------------------------------------- load take --

async function loadTake(name) {
  const base = `/data/${name.split('/').map(encodeURIComponent).join('/')}/`;
  const res = await fetch(`${base}scene.json`);
  if (!res.ok) throw new Error(`no scene.json for ${name}`);
  const sj = await res.json();
  const abs = (u) => (u ? base + u : null);
  const frames = sj.frames.map((f) => ({ ...camFrom(f.camera), url: abs(f.imageAsset?.url) }));
  const inputs = (sj.inputs || []).map((f) => ({
    ...camFrom(f.camera),
    url: abs(f.imageAsset?.url),
    depthUrl: abs(f.depth?.depthAsset?.url),
    confUrl: abs(f.depth?.confidenceAsset?.url),
  }));
  const cum = [0];
  for (let i = 1; i < frames.length; i++) cum.push(cum[i - 1] + frames[i].pos.distanceTo(frames[i - 1].pos));
  T = { name, frames, inputs, cum, fps: sj.fps || 24, total: cum.at(-1) };

  if (inputs[0]?.url) {
    T.inputImg = await loadImage(inputs[0].url);
    const c = document.createElement('canvas');
    c.width = 640; c.height = Math.round((640 * T.inputImg.naturalHeight) / T.inputImg.naturalWidth);
    c.getContext('2d').drawImage(T.inputImg, 0, 0, c.width, c.height);
    inputTex = new THREE.CanvasTexture(c);
    inputTex.colorSpace = THREE.SRGBColorSpace;
  }
  if (sj.videoAsset?.url) {
    const blob = await (await fetch(abs(sj.videoAsset.url))).blob();
    video.src = URL.createObjectURL(blob);
    await once(video, 'loadeddata');
  }
  T.firstImg = await frameImage(0);
  if (inputs[0]?.depthUrl && T.inputImg) {
    try { T.depth = await loadDepth(inputs[0]); } catch (e) { console.warn('depth', e); }
  }
}

// the input photo's depth map (+ confidence), for the point cloud
async function loadDepth(inp) {
  const exr = await new EXRLoader().setDataType(THREE.FloatType).loadAsync(inp.depthUrl);
  const { data, width, height } = exr.image;
  const stride = data.length / (width * height);
  const depth = new Float32Array(width * height);
  // EXRLoader stores rows bottom-up; flip back to image order
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) depth[y * width + x] = data[((height - 1 - y) * width + x) * stride];
  }
  let conf = null;
  if (inp.confUrl) {
    const px = pixels(await loadImage(inp.confUrl));
    conf = new Uint8Array(width * height);
    for (let i = 0; i < conf.length; i++) conf[i] = px[i * 4];
  }
  return { depth, conf, rgb: pixels(T.inputImg), w: width, h: height, cam: inp };
}

const imageCache = new Map();
function frameImage(i) {
  const url = T.frames[i]?.url;
  if (!url) return Promise.reject(new Error('no frame url'));
  if (!imageCache.has(url)) {
    const p = loadImage(url);
    imageCache.set(url, p);
    p.catch(() => imageCache.delete(url));
  }
  return imageCache.get(url);
}

// -------------------------------------------------------------- 3D objects --

function bounds() {
  const b = new THREE.Box3();
  for (const f of T.frames) b.expandByPoint(f.pos);
  if (S.inputCam) for (const f of T.inputs) b.expandByPoint(f.pos);
  return b;
}

function dispose(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
  if (obj === grid) obj.material.map?.dispose();
}

// Grid lines drawn into a texture with a radial fade, so the floor dissolves
// at the edges on any background (including transparent).
function gridTexture(div) {
  const px = 2048, c = document.createElement('canvas');
  c.width = c.height = px;
  const x = c.getContext('2d');
  x.strokeStyle = '#fff';
  x.lineWidth = Math.max(2, px / div / 36);
  x.beginPath();
  for (let k = 0; k <= div; k++) {
    const q = (k * px) / div;
    x.moveTo(q, 0); x.lineTo(q, px);
    x.moveTo(0, q); x.lineTo(px, q);
  }
  x.stroke();
  x.globalCompositeOperation = 'destination-in';
  const g = x.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.85)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, px, px);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function rebuildGrid() {
  if (grid) { world.remove(grid); dispose(grid); grid = null; }
  if (!S.grid || !T) return;
  const b = bounds();
  const c = b.getCenter(v3()), sz = b.getSize(v3());
  const div = Math.ceil((Math.max(sz.x, sz.z) + 8) / GRID_CELL / 2) * 2;
  grid = new THREE.Mesh(new THREE.PlaneGeometry(div * GRID_CELL, div * GRID_CELL), new THREE.MeshBasicMaterial({
    map: gridTexture(div), color: fx().gridColor, transparent: true, opacity: fx().gridOpacity,
    depthWrite: false, side: THREE.DoubleSide,
  }));
  grid.rotation.x = -Math.PI / 2;
  grid.position.set(Math.round(c.x / GRID_CELL) * GRID_CELL, S.gridY, Math.round(c.z / GRID_CELL) * GRID_CELL);
  grid.renderOrder = -1;
  world.add(grid);
}

// the input photo unprojected through its depth map, one colored point per (strided) pixel
function rebuildCloud() {
  if (cloud) { world.remove(cloud); dispose(cloud); cloud = null; }
  if (!S.cloud || !T?.depth) return;
  const { depth, conf, rgb, w, h, cam } = T.depth;
  const st = CLOUD.stride, thr = CLOUD.minConfidence * 255, edge = 0.03 * st;
  const pos = [], col = [];
  const p = v3();
  for (let y = 0; y < h; y += st) {
    for (let x = 0; x < w; x += st) {
      const i = y * w + x, d = depth[i];
      if (!(d > 0) || d > CLOUD.maxDepth) continue;
      if (conf && conf[i] < thr) continue;
      // skip pixels on depth edges, which would smear into streaks
      const a = depth[y * w + Math.min(x + st, w - 1)], b = depth[Math.min(y + st, h - 1) * w + x];
      if (Math.abs(a - d) > edge * d || Math.abs(b - d) > edge * d) continue;
      p.set(((x + 0.5 - cam.cx) / cam.fx) * d, (-(y + 0.5 - cam.cy) / cam.fy) * d, -d)
        .applyQuaternion(cam.quat).add(cam.pos);
      pos.push(p.x, p.y, p.z);
      col.push(LIN[rgb[i * 4]], LIN[rgb[i * 4 + 1]], LIN[rgb[i * 4 + 2]]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  cloud = new THREE.Points(geo, new THREE.PointsMaterial({ size: S.cloudSize, vertexColors: true, sizeAttenuation: true }));
  world.add(cloud);
}

// a floor height from the lowest part of the point cloud
function floorFromCloud() {
  if (!T?.depth) return null;
  const { depth, w, h, cam } = T.depth;
  const ys = [];
  const p = v3();
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4) {
      const d = depth[y * w + x];
      if (!(d > 0) || d > CLOUD.maxDepth) continue;
      p.set(((x - cam.cx) / cam.fx) * d, (-(y - cam.cy) / cam.fy) * d, -d).applyQuaternion(cam.quat).add(cam.pos);
      ys.push(p.y);
    }
  }
  ys.sort((a, b) => a - b);
  return ys[Math.floor(ys.length * 0.02)];
}

// Path and frustums are drawn in their own pass on top of the grid / point
// cloud. Inside that pass, frame images fade the path behind them.
function lineMat(color, width, opacity = 1, extra = {}) {
  const m = new LineMaterial({
    color: new THREE.Color(color).getHex(),
    linewidth: width * ss,
    transparent: true,
    opacity,
    worldUnits: false,
    depthWrite: false,
    ...extra,
  });
  m.userData.w = width;
  const v = rects().view;
  m.resolution.set(v.w * ss, v.h * ss);
  lineMats.push(m);
  return m;
}

function makeLine(mat, order) {
  const l = new Line2(new LineGeometry().setPositions([0, 0, 0, 0, 0, 0]), mat);
  l.frustumCulled = false;
  l.renderOrder = order;
  ov.add(l);
  return l;
}

// A faded copy of a path piece that only draws where something (a frame
// image) is in front of it.
function addGhost(obj, material) {
  material.depthFunc = THREE.GreaterDepth;
  material.opacity *= GHOST_OPACITY;
  const g = new obj.constructor(obj.geometry, material);
  g.frustumCulled = false;
  g.renderOrder = obj.renderOrder - 1;
  ov.add(g);
  obj.userData.ghost = g;
}

function setGeometry(obj, geo) {
  obj.geometry.dispose();
  obj.geometry = geo;
  if (obj.userData.ghost) obj.userData.ghost.geometry = geo;
}

function setLine(line, arr) {
  if (!line) return;
  const ghost = line.userData.ghost;
  if (arr.length < 6) {
    line.visible = false;
    if (ghost) ghost.visible = false;
    return;
  }
  setGeometry(line, new LineGeometry().setPositions(arr));
  if (line.material.dashed) line.computeLineDistances();
  line.visible = true;
  if (ghost) ghost.visible = true;
}

function makeFrustum(cam, { size, color, width, fill, tex, opacity = 1, order = 10 }) {
  const g = new THREE.Group();
  const h = 2 * Math.tan(cam.vfov / 2) * size, w = h * (cam.w / cam.h), z = -size;
  const C = [[-w / 2, h / 2, z], [w / 2, h / 2, z], [w / 2, -h / 2, z], [-w / 2, -h / 2, z]];
  if (fill > 0) {
    const tri = [];
    for (let i = 0; i < 4; i++) tri.push(0, 0, 0, ...C[i], ...C[(i + 1) % 4]);
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
    const m = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: fill * opacity, side: THREE.DoubleSide, depthWrite: false, fog: false,
    }));
    m.renderOrder = order;
    g.add(m);
  }
  if (tex) {
    const mat = new THREE.MeshBasicMaterial({
      map: tex, side: THREE.DoubleSide, transparent: opacity < 1, opacity, fog: false,
      // pushed back slightly so the frustum's own outline isn't hidden by it
      polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    plane.position.z = z;
    plane.renderOrder = order + 1;
    g.add(plane);
  }
  const segs = [];
  for (const c of C) segs.push(0, 0, 0, ...c);
  for (let i = 0; i < 4; i++) segs.push(...C[i], ...C[(i + 1) % 4]);
  const lines = new LineSegments2(new LineSegmentsGeometry().setPositions(segs), lineMat(color, width, opacity));
  lines.renderOrder = order + 2;
  g.add(lines);
  g.traverse((o) => { o.frustumCulled = false; });
  g.position.copy(cam.pos);
  g.quaternion.copy(cam.quat);
  ov.add(g);
  return g;
}

function keyIndices() {
  const n = T.frames.length, every = Math.max(1, Math.round(S.keyEvery));
  const out = [];
  for (let i = 0; i < n; i += every) out.push(i);
  if (n - 1 - out.at(-1) > every / 2) out.push(n - 1);
  return out;
}

function rebuildOverlay() {
  if (!T) return;
  dispose(ov);
  ov.clear();
  lineMats.length = 0;
  dotMats.length = 0;
  for (const k of Object.keys(O)) delete O[k];
  const { camWidth, camFill } = fx();

  if (S.inputCam && inputTex) {
    for (const inp of T.inputs) {
      makeFrustum(inp, { size: S.inputSize, color: S.inputColor, width: camWidth, fill: camFill, tex: inputTex, order: 4 });
    }
  }
  O.keys = [];
  if (S.keyframes !== 'off') {
    for (const k of keyIndices()) {
      const g = makeFrustum(T.frames[k], {
        size: S.keySize, color: S.keyColor, width: Math.max(1, camWidth * 0.7), fill: camFill * 0.6,
        tex: thumb(k), opacity: KEY_OPACITY, order: 6,
      });
      O.keys.push({ k, g });
    }
  }
  O.past = makeLine(lineMat(S.pathColor, S.pathWidth), 20);
  addGhost(O.past, lineMat(S.pathColor, S.pathWidth));
  if (S.futureStyle === 'dotted') {
    const m = new THREE.PointsMaterial({
      color: S.pathColor, size: S.pathWidth * 1.15 * ss, sizeAttenuation: false, map: dotTex,
      transparent: true, opacity: S.futureOpacity, depthWrite: false, fog: false,
    });
    m.userData.size = S.pathWidth * 1.15;
    dotMats.push(m);
    O.dots = new THREE.Points(new THREE.BufferGeometry(), m);
    O.dots.frustumCulled = false;
    O.dots.renderOrder = 19;
    ov.add(O.dots);
    const gm = m.clone();
    dotMats.push(gm);
    addGhost(O.dots, gm);
  } else if (S.futureStyle !== 'hidden') {
    const dashed = S.futureStyle === 'dashed';
    const futureMat = () => lineMat(S.pathColor, S.pathWidth * (dashed ? 0.85 : 1), S.futureOpacity, {
      dashed, dashSize: S.dashSize, gapSize: S.dashSize * 0.8,
    });
    O.future = makeLine(futureMat(), 19);
    addGhost(O.future, futureMat());
  }
  O.cur = makeFrustum(T.frames[0], {
    size: S.camSize, color: S.camColor, width: camWidth, fill: camFill,
    tex: S.camImage ? liveTex : null, order: 30,
  });
  overlayFrame = -1;
}

function pointAt(s) {
  const { cum, frames } = T;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const t = cum[hi] > cum[lo] ? (s - cum[lo]) / (cum[hi] - cum[lo]) : 0;
  return frames[lo].pos.clone().lerp(frames[hi].pos, clamp(t, 0, 1));
}

function updateOverlay(i) {
  if (overlayFrame === i) return;
  overlayFrame = i;
  const F = T.frames, n = F.length;
  const flat = (a, b) => F.slice(a, b).flatMap((f) => f.pos.toArray());
  setLine(O.past, flat(0, i + 1));
  if (O.future) {
    setLine(O.future, flat(i, n));
    O.future.material.dashOffset = T.cum[i];
    if (O.future.userData.ghost) O.future.userData.ghost.material.dashOffset = T.cum[i];
  }
  if (O.dots) {
    // dots sit at fixed distances from the start of the path, so they stay put
    // and disappear as the camera passes them
    const step = Math.max(0.01, S.dashSize), arr = [];
    for (let k = Math.floor(T.cum[i] / step) + 1; k * step <= T.total + 1e-6; k++) arr.push(...pointAt(k * step).toArray());
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    setGeometry(O.dots, geo);
  }
  O.cur.position.copy(F[i].pos);
  O.cur.quaternion.copy(F[i].quat);
  for (const { k, g } of O.keys) g.visible = S.keyframes === 'all' || k <= i;
}

// ------------------------------------------------------------------- views --

// Points that should stay in frame: the path and a few frustums.
function fitPoints() {
  const pts = T.frames.map((f) => f.pos);
  const add = (cam, size) => {
    const h = 2 * Math.tan(cam.vfov / 2) * size, w = (h * cam.w) / cam.h;
    for (const [x, y] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) {
      pts.push(v3((x * w) / 2, (y * h) / 2, -size).applyQuaternion(cam.quat).add(cam.pos));
    }
  };
  T.frames.forEach((f, i) => { if (i % 10 === 0 || i === T.frames.length - 1) add(f, S.camSize); });
  if (S.inputCam) T.inputs.forEach((c) => add(c, S.inputSize));
  return pts;
}

// Place the orbit camera along `dir` so the projected path fills the window
// `win` (NDC center cx/cy and half-extents hx/hy) of the 3D panel.
function frameAlong(dir, win) {
  const pts = fitPoints();
  const box = new THREE.Box3().setFromPoints(pts);
  const target = box.getCenter(v3());
  const vf = THREE.MathUtils.degToRad(cam3.fov);
  let dist = (box.getSize(v3()).length() / 2 / Math.sin(vf / 2)) * 1.5;
  const q = v3(), right = v3(), up = v3();
  for (let it = 0; it < 8; it++) {
    cam3.position.copy(target).addScaledVector(dir, dist);
    cam3.lookAt(target);
    cam3.updateMatrixWorld();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) {
      q.copy(p).project(cam3);
      x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
      y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
    }
    right.setFromMatrixColumn(cam3.matrixWorld, 0);
    up.setFromMatrixColumn(cam3.matrixWorld, 1);
    const halfH = Math.tan(vf / 2) * dist, halfW = halfH * cam3.aspect;
    target.addScaledVector(right, ((x0 + x1) / 2 - win.cx) * halfW).addScaledVector(up, ((y0 + y1) / 2 - win.cy) * halfH);
    dist *= Math.max((x1 - x0) / 2 / win.hx, (y1 - y0) / 2 / win.hy, 0.05);
  }
  controls.target.copy(target);
  cam3.position.copy(target).addScaledVector(dir, dist);
}

// Part of the 3D panel the auto-framing fills, clear of the pictures beside it
// (NDC center + half extents).
function fitWindow() {
  if (layout === 'overlay') return { cx: 0, cy: -0.05, hx: 0.82, hy: 0.72 };
  const R = rects();
  if (!R.output && !R.input) return { cx: 0, cy: -0.02, hx: 0.82, hy: 0.7 };
  const col = ((544 * S.pipScale + 40) / W) * 2;        // NDC width of the picture column
  return { cx: (R.pipRight ? -1 : 1) * (col / 2), cy: -0.02, hx: Math.max(0.3, 0.88 - col / 2), hy: 0.68 };
}

// Horizontal frame anchored to the input camera's heading, so a view angle
// chosen on one take means the same thing on another take of the scene.
function sceneBasis() {
  const up = v3(0, 1, 0);
  const fwd = T.inputs[0] ? v3(0, 0, -1).applyQuaternion(T.inputs[0].quat).setY(0) : v3(0, 0, -1);
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  return { fwd, side: v3().crossVectors(fwd, up).normalize(), up };
}
// Horizontal frame along the path's overall travel direction, or null for
// loops / orbits where start ≈ end and "forward" means nothing.
function pathBasis() {
  const F = T.frames, up = v3(0, 1, 0);
  const span = bounds().getSize(v3()).setY(0).length();
  const fwd = F.at(-1).pos.clone().sub(F[0].pos).setY(0);
  if (fwd.lengthSq() < 1e-6 || fwd.length() < 0.25 * span) return null;
  fwd.normalize();
  return { fwd, side: v3().crossVectors(fwd, up).normalize(), up };
}
function toRel(basis, p, t) {
  const d = v3(...p).sub(v3(...t)).normalize();
  return [d.dot(basis.side), d.dot(basis.up), d.dot(basis.fwd)];
}
function fromRel(basis, [a, b, c]) {
  return basis.side.clone().multiplyScalar(a).addScaledVector(basis.up, b).addScaledVector(basis.fwd, c).normalize();
}

// Views are kept exactly per take. Each layout also remembers the last angle
// you chose, both relative to the path's travel direction (used for paths
// that go somewhere, so side-on stays side-on) and relative to the scene
// (used for loops). A new take opens from that angle, re-framed to fit.
function saveView() {
  const p = cam3.position.toArray(), t = controls.target.toArray();
  (store.views[T.name] ??= {})[layout] = { p, t };
  const a = (store.angles[layout] ??= {});
  a.scene = toRel(sceneBasis(), p, t);
  const pb = pathBasis();
  if (pb) a.path = toRel(pb, p, t);
  save();
}

function applyPreset(kind) {
  if (!T) return;
  // "forward" is the overall travel direction; for loops/orbits (start ≈ end)
  // fall back to the input camera's heading
  const fwd = (pathBasis() || sceneBasis()).fwd;
  const up = v3(0, 1, 0);
  const side = v3().crossVectors(fwd, up).normalize();
  let dir;
  if (kind === 'side') dir = side.clone().addScaledVector(up, 0.2);
  else if (kind === 'top') dir = up.clone().addScaledVector(fwd, -0.03);
  else if (kind === 'behind') dir = fwd.clone().negate().addScaledVector(up, 0.45);
  else dir = side.clone().multiplyScalar(0.85).addScaledVector(fwd, -0.45).addScaledVector(up, 0.6);
  dir.normalize();
  cam3.up.set(0, 1, 0);
  frameAlong(dir, fitWindow());
  controls.update();
  saveView();
}

// re-fit the current view angle, e.g. after the pictures beside the 3D scene move
function refit() {
  const dir = cam3.position.clone().sub(controls.target).normalize();
  frameAlong(dir, fitWindow());
  controls.update();
  saveView();
}

function restoreView() {
  cam3.fov = 35;
  cam3.updateProjectionMatrix();
  const exact = store.views[T.name]?.[layout];
  if (exact) {
    cam3.position.fromArray(exact.p);
    controls.target.fromArray(exact.t);
    controls.update();
    return;
  }
  const angle = store.angles[layout] || START_ANGLES[layout];
  const pb = pathBasis();
  const dir = pb && angle.path ? fromRel(pb, angle.path) : fromRel(sceneBasis(), angle.scene);
  cam3.up.set(0, 1, 0);
  frameAlong(dir, fitWindow());
  controls.update();
  saveView();
}

function updateCamera() {
  if (!exporting) controls.update();
  if (fx().fog) {
    const d = cam3.position.distanceTo(controls.target);
    fog.color.set(S.bg3d);
    fog.near = d * 0.9;
    fog.far = d * 2.8;
    scene3.fog = fog;
  } else scene3.fog = null;
}

// ------------------------------------------------------------------- stage --

function stats(i) {
  const F = T.frames, f = F[i], n = F.length;
  const fwd = v3(0, 0, -1).applyQuaternion(f.quat);
  const yaw = deg(Math.atan2(-fwd.x, -fwd.z));
  const pitch = deg(Math.asin(clamp(fwd.y, -1, 1)));
  const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
  const speed = b > a ? (T.cum[b] - T.cum[a]) / ((b - a) / T.fps) : 0;
  return {
    frame: `${pad(i + 1)} / ${pad(n)}`,
    time: `${(i / T.fps).toFixed(2)} s`,
    traveled: `${T.cum[i].toFixed(2)} / ${T.total.toFixed(2)} ${UNIT}`,
    speed: `${speed.toFixed(2)} ${UNIT}/s`,
    pos: `${signed(f.pos.x)} ${signed(f.pos.y)} ${signed(f.pos.z)}`,
    orient: `${signed(yaw, 1)}°  ${signed(pitch, 1)}°`,
    lens: `${deg(f.hfov).toFixed(0)}° · ${((36 * f.fx) / f.w).toFixed(0)} mm`,
  };
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
// ---- video look: a light color grade applied to every frame we draw
function gradedDraw(c, img, x, y, w, h) {
  const f = [];
  if (S.gradeBrightness !== 1) f.push(`brightness(${S.gradeBrightness})`);
  if (S.gradeContrast !== 1) f.push(`contrast(${S.gradeContrast})`);
  if (S.gradeSaturation !== 1) f.push(`saturate(${S.gradeSaturation})`);
  c.save();
  c.filter = f.join(' ') || 'none';
  c.drawImage(img, x, y, w, h);
  c.restore();
}
// Frame textures inside the 3D frustums get the same grade.
function regradeTextures() {
  for (const t of thumbs.values()) {
    if (!t.img) continue;
    gradedDraw(t.canvas.getContext('2d'), t.img, 0, 0, t.canvas.width, t.canvas.height);
    t.tex.needsUpdate = true;
  }
  if (inputTex && T?.inputImg) {
    const c = inputTex.image;
    gradedDraw(c.getContext('2d'), T.inputImg, 0, 0, c.width, c.height);
    inputTex.needsUpdate = true;
  }
}
function easedStops(g, alpha, reverse = false) {
  for (let k = 0; k <= 6; k++) {
    const t = k / 6;
    g.addColorStop(reverse ? 1 - t : t, `rgba(0,0,0,${(alpha * t * t).toFixed(4)})`);
  }
}
function drawVignette(r) {
  if (!(S.vignette > 0)) return;
  ctx.save();
  // elliptical falloff that follows the frame's aspect ratio
  ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
  ctx.scale(r.w / r.h, 1);
  const outer = (r.h / 2) * Math.SQRT2;
  const g = ctx.createRadialGradient(0, 0, outer * VIGNETTE_SIZE, 0, 0, outer);
  easedStops(g, S.vignette);
  ctx.fillStyle = g;
  ctx.fillRect(-r.h / 2, -r.h / 2, r.h, r.h);
  ctx.restore();
}
// top / bottom shading, so overlays read on bright footage
function drawScrim() {
  if (!(S.scrim > 0)) return;
  const bh = H * SCRIM.bottomSize, th = H * SCRIM.topSize;
  let g = ctx.createLinearGradient(0, H - bh, 0, H);
  easedStops(g, SCRIM.bottom * S.scrim);
  ctx.fillStyle = g;
  ctx.fillRect(0, H - bh, W, bh);
  g = ctx.createLinearGradient(0, 0, 0, th);
  easedStops(g, SCRIM.top * S.scrim, true);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, th);
}

function drawCover(img, r, radius = 0) {
  if (!img) return;
  const iw = img.videoWidth || img.naturalWidth || img.width;
  const ih = img.videoHeight || img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const s = Math.max(r.w / iw, r.h / ih), dw = iw * s, dh = ih * s;
  ctx.save();
  roundRect(r.x, r.y, r.w, r.h, radius);
  ctx.clip();
  gradedDraw(ctx, img, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, dw, dh);
  ctx.restore();
}
function text(str, x, y, { size = 16, weight = 500, font = SANS, color = TEXT, align = 'left', alpha = 1, spacing = 0 } = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.globalAlpha *= alpha;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(str, x, y);
  ctx.restore();
}
function progressBar(x, y, w, h, i, track = hexA(TEXT, 0.12)) {
  const p = T.frames.length > 1 ? i / (T.frames.length - 1) : 1;
  ctx.fillStyle = track;
  roundRect(x, y, w, h, h / 2); ctx.fill();
  ctx.fillStyle = ACCENT;
  roundRect(x, y, Math.max(h, w * p), h, h / 2); ctx.fill();
}

// the 3D render, with a soft shadow behind it (so the path reads over bright video)
function drawGL(r) {
  const shadow = fx().shadow;
  ctx.save();
  if (shadow > 0) {
    ctx.shadowColor = `rgba(0,0,0,${shadow})`;
    ctx.shadowBlur = 18;
  }
  ctx.drawImage(gl, r.x, r.y, r.w, r.h);
  ctx.restore();
}

function drawOverlay(i, src, alpha) {
  const R = rects();
  if (!alpha) {
    drawCover(src, R.output);
    drawVignette(R.output);
    drawScrim();
  }
  if (S.showInset) drawGL(R.view);
  if (!S.showHud) return;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 12;
  const s = stats(i);
  if (S.title) text(S.title, 56, 86, { size: 40, weight: 700 });
  if (S.subtitle) text(S.subtitle, 56, 120, { size: 20, alpha: 0.8 });
  if (S.showLabels) {
    text('FRAME', W - 56 - 250, 78, { size: 13, weight: 600, alpha: 0.65, spacing: 1.4 });
    text(s.frame, W - 56, 78, { size: 22, font: MONO, align: 'right' });
    text(s.time, W - 56, 108, { size: 18, font: MONO, align: 'right', alpha: 0.75 });
  }
  if (S.showStats) {
    const rows = [['TRAVELED', s.traveled], ['SPEED', s.speed], ['YAW · PITCH', s.orient], ['LENS', s.lens], ['POSITION', s.pos]];
    const bw = 470, bx = R.statsLeft ? 56 : W - 56 - bw, by = H - 56 - (rows.length - 1) * 40;
    rows.forEach(([l, v], k) => {
      text(l, bx, by + k * 40, { size: 13, weight: 600, alpha: 0.65, spacing: 1.4 });
      text(v, bx + bw, by + k * 40, { size: 21, font: MONO, align: 'right' });
    });
  }
  ctx.restore();
  if (S.showProgress) progressBar(0, H - 6, W, 6, i, 'rgba(255,255,255,0.18)');
}

function drawWorld(i, src, alpha) {
  const R = rects();
  drawGL(R.view);
  if (!alpha) {
    drawVignette(R.view);
    for (const [r, img, label] of [[R.output, src, 'Output'], [R.input, T.inputImg, 'Input']]) {
      if (!r || !img) continue;
      drawCover(img, r, 10);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1.5;
      roundRect(r.x, r.y, r.w, r.h, 10); ctx.stroke();
      if (S.showLabels) text(label, r.x, r.y + r.h + 30, { size: 17, weight: 600, color: label === 'Input' ? S.inputColor : ACCENT });
    }
  }
  if (!S.showHud) return;
  const s = stats(i);
  if (S.title) text(S.title, 56, 86, { size: 40, weight: 700 });
  if (S.subtitle) text(S.subtitle, 56, 120, { size: 20, alpha: 0.75 });
  if (S.showStats) {
    const cells = [['FRAME', s.frame], ['TRAVELED', s.traveled], ['SPEED', s.speed], ['YAW · PITCH', s.orient], ['LENS', s.lens]];
    cells.forEach(([l, v], k) => {
      const x = 56 + k * 250;
      text(l, x, H - 84, { size: 12, weight: 600, alpha: 0.55, spacing: 1.3 });
      text(v, x, H - 52, { size: 20, font: MONO });
    });
  }
  if (S.showProgress) progressBar(56, H - 28, W - 112, 4, i);
}

// ---- wiggle: a small periodic swing of the view around its target so the
// depth reads, applied at render time only (orbit controls never see it)
function wiggleAngles(t, period) {
  const A = THREE.MathUtils.degToRad(S.wiggleAmount);
  const ph = (2 * Math.PI * t) / period;
  switch (S.wiggle) {
    case 'sway': return [A * Math.sin(ph), 0];
    case 'figure8': return [A * Math.sin(ph), 0.35 * A * Math.sin(2 * ph)];
    case 'circle': return [A * Math.sin(ph), 0.5 * A * Math.cos(ph) - 0.5 * A];
    case 'wigglegram': return [A * [0, 1, 0, -1][Math.floor((t / period) * 4) % 4], 0];
    default: return [0, 0];
  }
}
function viewCamera(t, period) {
  if (S.wiggle === 'off' || !S.wiggleAmount) return cam3;
  const [yaw, pitch] = wiggleAngles(t, period);
  const up = v3(0, 1, 0), target = controls.target;
  const off = cam3.position.clone().sub(target).applyAxisAngle(up, yaw);
  const right = v3().crossVectors(up, off);
  if (right.lengthSq() > 1e-9) off.applyAxisAngle(right.normalize(), pitch);
  viewCam.copy(cam3);
  viewCam.position.copy(target).add(off);
  viewCam.lookAt(target);
  viewCam.updateMatrixWorld();
  return viewCam;
}

function render(i, src, { alpha = false, t = 0, period = WIGGLE_PERIOD } = {}) {
  if (!T) return;
  if (src) {
    gradedDraw(liveCtx, src, 0, 0, live.width, live.height);
    liveTex.needsUpdate = true;
  }
  updateOverlay(i);
  updateCamera();
  const cam = viewCamera(t, period);
  renderer.setClearColor(S.bg3d, alpha || fx().transparent3d ? 0 : 1);
  if (!show3D()) {
    // nothing 3D on screen
  } else if (fx().pathOnTop) {
    // pass 1: grid + point cloud; pass 2: path + frustums with a fresh depth buffer
    renderer.autoClear = false;
    renderer.clear();
    ov.visible = false;
    renderer.render(scene3, cam);
    renderer.clearDepth();
    ov.visible = true;
    world.visible = false;
    renderer.render(scene3, cam);
    world.visible = true;
    renderer.autoClear = true;
  } else renderer.render(scene3, cam);
  ctx.clearRect(0, 0, W, H);
  if (!alpha) {
    ctx.fillStyle = fx().stageBg;
    ctx.fillRect(0, 0, W, H);
  }
  if (layout === 'overlay') drawOverlay(i, src, alpha);
  else drawWorld(i, src, alpha);
}

// --------------------------------------------------------------- playback --

const scrub = $('scrub');
const hasVideo = () => !!video.src;
let clockStart = 0;                // playback clock when there's no video file
const shown = { want: -1, img: null };
// the frame image to show when there's no video to play from
function frameSource(i) {
  if (shown.want !== i) {
    shown.want = i;
    frameImage(i).then((img) => { if (shown.want === i) shown.img = img; }).catch(() => {});
  }
  return shown.img || T.firstImg;
}
function frameFromVideo() {
  return clamp(Math.floor(video.currentTime * T.fps + 1e-3), 0, T.frames.length - 1);
}
function syncUI() {
  const n = T.frames.length;
  scrub.value = frame;
  scrub.style.setProperty('--p', `${n > 1 ? (frame / (n - 1)) * 100 : 0}%`);
  $('frameLabel').textContent = `${pad(frame + 1, 4)} / ${pad(n, 4)}`;
}
function setFrame(i) {
  frame = clamp(Math.round(i), 0, T.frames.length - 1);
  if (hasVideo()) video.currentTime = (frame + 0.5) / T.fps;
  syncUI();
}
function setPlayIcon() {
  $('playIcon').setAttribute('d', playing ? 'M2.5 1.5h2.6v9H2.5zM6.9 1.5h2.6v9H6.9z' : 'M3 1.5v9l7.5-4.5z');
  $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}
// While the video plays, follow the frames it actually puts on screen, so the path and camera move in
// lockstep with the picture (sampling video.currentTime at the display rate lags it by a frame now and then).
const followsVideoFrames = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
function onVideoFrame(_, meta) {
  if (!playing) return;
  const f = clamp(Math.round(meta.mediaTime * T.fps), 0, T.frames.length - 1);
  if (f !== frame) { frame = f; syncUI(); }
  video.requestVideoFrameCallback(onVideoFrame);
}
function play() {
  if (!T) return;
  playing = true;
  if (hasVideo()) {
    video.play();
    if (followsVideoFrames) video.requestVideoFrameCallback(onVideoFrame);
  } else clockStart = performance.now() - (frame / T.fps) * 1000;
  setPlayIcon();
}
function pause() {
  if (!playing) return;
  playing = false;
  if (hasVideo()) { video.pause(); setFrame(frameFromVideo()); }
  setPlayIcon();
}
$('playBtn').onclick = () => (playing ? pause() : play());
scrub.oninput = () => { pause(); setFrame(+scrub.value); };
window.addEventListener('keydown', (e) => {
  if (!T || exporting || !$('confirm').hidden || e.target.closest?.('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
  if (e.code === 'ArrowRight') { pause(); setFrame(frame + 1); }
  if (e.code === 'ArrowLeft') { pause(); setFrame(frame - 1); }
});

let seekSince = null;
function loop(now) {
  requestAnimationFrame(loop);
  if (!T || exporting) return;
  if (playing && !(hasVideo() && followsVideoFrames)) {
    const f = hasVideo() ? frameFromVideo() : Math.floor(((now - clockStart) / 1000) * T.fps) % T.frames.length;
    if (f !== frame) { frame = f; syncUI(); }
  }
  // Pausing or scrubbing makes the video seek, and it has no picture until the seek lands. Keep the
  // last frame on screen meanwhile (a seek takes a frame or two) rather than flashing something else.
  if (hasVideo() && (video.seeking || video.readyState < 2)) {
    seekSince ??= now;
    if (now - seekSince < 500) return;
  } else seekSince = null;
  const src = hasVideo() && video.readyState >= 2 ? video : frameSource(frame);
  render(frame, src, { t: now / 1000 });
}

// ----------------------------------------------------------------- export --

function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 8000 : 5000);
}
function showProgress(msg, p) {
  $('overlay').classList.add('show');
  $('overlayText').textContent = msg;
  $('overlayBar').style.width = `${Math.round(p * 100)}%`;
}
const hideProgress = () => $('overlay').classList.remove('show');
const toBlob = () => new Promise((r) => stage.toBlob(r, 'image/png'));
async function postJSON(url, body, json = true) {
  const res = await fetch(url, { method: 'POST', body: json ? JSON.stringify(body) : body });
  const out = await res.json();
  if (!res.ok || out.error) throw new Error(out.error || res.statusText);
  return out;
}
// hand a finished file to the browser as a normal download (a copy stays in the take's exports folder)
function download({ url, name }) {
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}
function exportName(alpha) {
  return S.exportName || `${T.name.split('/').at(-1)}-${layout === 'world' ? '3d-scene' : 'video'}${alpha ? '-alpha' : ''}`;
}

async function withExportState(fn) {
  pause();
  exporting = true;
  setRenderSize(EXPORT_SS);
  overlayFrame = -1;
  try {
    await Promise.all([...thumbs.values()].map((t) => t.ready));
    return await fn();
  } finally {
    exporting = false;
    setRenderSize(1);
    overlayFrame = -1;
    hideProgress();
  }
}

// Renders every frame at full size and hands them to the server, which encodes with ffmpeg; the
// result downloads through the browser. Resolves to the path of the copy in the take's exports folder.
async function exportVideo(alpha = false) {
  if (!T || exporting) return null;
  try {
    const file = await withExportState(async () => {
      const n = T.frames.length, dur = n / T.fps;
      const period = dur / Math.max(1, Math.round(dur / WIGGLE_PERIOD));   // so the wiggle loops cleanly
      const { id } = await postJSON('/api/export/start', { take: T.name, name: exportName(alpha), fps: T.fps, alpha });
      for (let i = 0; i < n; i++) {
        const img = await frameImage(i);
        if (i + 1 < n) frameImage(i + 1);
        if (i >= 2) imageCache.delete(T.frames[i - 2].url);
        render(i, img, { alpha, t: i / T.fps, period });
        await postJSON(`/api/export/frame?id=${id}&i=${i}`, await toBlob(), false);
        showProgress(`Rendering frame ${i + 1} of ${n}`, (i + 1) / n);
      }
      showProgress('Encoding…', 1);
      return postJSON(`/api/export/finish?id=${id}`, {});
    });
    download(file);
    toast(`Downloaded ${file.name}`);
    return file.path;
  } catch (e) {
    toast(`Export failed: ${e.message}`, 'error');
    throw e;
  }
}

async function snapshot() {
  if (!T || exporting) return null;
  try {
    const file = await withExportState(async () => {
      render(frame, await frameImage(frame), { t: performance.now() / 1000 });
      const q = new URLSearchParams({ take: T.name, name: `${exportName(false)}-f${pad(frame + 1)}` });
      return postJSON(`/api/snapshot?${q}`, await toBlob(), false);
    });
    download(file);
    toast(`Downloaded ${file.name}`);
    return file.path;
  } catch (e) {
    toast(`Snapshot failed: ${e.message}`, 'error');
    throw e;
  }
}
const quiet = (p) => p.catch(() => {});
$('exportBtn').onclick = () => quiet(exportVideo(false));
const EXPORT_ACTIONS = { mp4: () => exportVideo(false), alpha: () => exportVideo(true), snapshot };
for (const b of $('exportMenu').querySelectorAll('[data-export]')) {
  b.onclick = () => { closeMenus(); quiet(EXPORT_ACTIONS[b.dataset.export]()); };
}

// --------------------------------------------------------------------- gui --

const gui = new GUI({ container: $('side') });

// Color picker: a small in-page popover instead of the system color dialog (which a page can't close).
// Clicking a swatch opens it; clicking the swatch again, anywhere else, or Esc closes it.
const picker = (() => {
  const el = document.createElement('div');
  el.className = 'picker';
  el.hidden = true;
  el.innerHTML = '<div class="sv"><i></i></div><input class="hue" type="range" min="0" max="359" step="1" aria-label="Hue">'
    + '<div class="row"><span class="chip"></span><input class="hex" spellcheck="false" maxlength="7" aria-label="Hex color"></div>';
  document.body.append(el);
  const sv = el.querySelector('.sv'), knob = sv.querySelector('i'), hue = el.querySelector('.hue');
  const hex = el.querySelector('.hex'), chip = el.querySelector('.chip');
  let ctrl = null, h = 0, s = 0, v = 0;           // the controller being edited, and its color as HSV
  const toHex = () => {
    const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return `#${[f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
  };
  const fromHex = (str) => {
    const n = parseInt(str.replace('#', ''), 16), r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
    if (d) h = (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
    s = mx ? d / mx : 0;
    v = mx;
  };
  const paint = () => {
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h}, 100%, 50%))`;
    knob.style.left = `${s * 100}%`;
    knob.style.top = `${(1 - v) * 100}%`;
    hue.value = Math.round(h);
    chip.style.background = toHex();
    if (document.activeElement !== hex) hex.value = toHex();
  };
  const apply = () => { paint(); ctrl?.setValue(toHex()); };
  const close = () => { el.hidden = true; ctrl = null; };
  const open = (c) => {
    if (ctrl === c) { close(); return; }
    ctrl = c;
    fromHex(c.getValue());
    el.hidden = false;
    paint();
    const r = (c.domElement.querySelector('.display') || c.domElement).getBoundingClientRect();
    const w = el.offsetWidth, ht = el.offsetHeight;
    el.style.left = `${clamp(r.right - w, 8, innerWidth - w - 8)}px`;
    el.style.top = `${r.bottom + 6 + ht > innerHeight - 8 ? r.top - ht - 6 : r.bottom + 6}px`;
  };
  const drag = (e) => {
    const r = sv.getBoundingClientRect();
    s = clamp((e.clientX - r.left) / r.width, 0, 1);
    v = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
    apply();
  };
  sv.addEventListener('pointerdown', (e) => { sv.setPointerCapture(e.pointerId); drag(e); });
  sv.addEventListener('pointermove', (e) => { if (sv.hasPointerCapture(e.pointerId)) drag(e); });
  hue.addEventListener('input', () => { h = +hue.value; apply(); });
  hex.addEventListener('input', () => { if (/^#?[0-9a-f]{6}$/i.test(hex.value)) { fromHex(hex.value); apply(); } });
  document.addEventListener('pointerdown', (e) => { if (ctrl && !el.contains(e.target) && !ctrl.domElement.contains(e.target)) close(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ctrl) close(); });
  $('side').addEventListener('scroll', close);
  window.addEventListener('resize', close);
  // take over every color swatch in the side panel
  const attach = () => {
    for (const c of gui.controllersRecursive()) {
      const native = c.domElement.querySelector('input[type="color"]');
      if (!native) continue;
      native.addEventListener('click', (e) => { e.preventDefault(); open(c); });
      native.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(c); } });
    }
  };
  return { attach, close };
})();
const layoutOnly = [];               // [controller, layouts it applies to]
function refreshGui() {
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  for (const [c, l] of layoutOnly) c.show(l.includes(layout));
}
const ui = { angle: '' };            // the "snap to angle" menu (not a setting)
const actions = {
  snapFloor: () => {
    const y = floorFromCloud();
    if (y != null) setSetting('gridY', +y.toFixed(3));
  },
  exportMp4: () => quiet(exportVideo(false)),
};

// what has to be rebuilt when a setting changes
const REBUILD_GRID = new Set(['grid', 'gridY', 'inputCam']);
const RESIZE = new Set(['insetCorner', 'insetScale', 'insetMargin']);
const REFIT = new Set(['showOutput', 'showInput', 'pipCorner', 'pipScale']);
const REGRADE = new Set(['gradeBrightness', 'gradeContrast', 'gradeSaturation']);
const REBUILD_OVERLAY = new Set(['pathColor', 'pathWidth', 'futureStyle', 'dashSize', 'futureOpacity',
  'camColor', 'camSize', 'camImage', 'keyframes', 'keyEvery', 'keyColor', 'keySize', 'inputCam', 'inputColor', 'inputSize']);
function settingChanged(property, value) {
  if (REBUILD_GRID.has(property)) rebuildGrid();
  if (REBUILD_OVERLAY.has(property)) rebuildOverlay();
  if (property === 'cloud') rebuildCloud();
  if (property === 'cloudSize' && cloud) cloud.material.size = value;
  if (RESIZE.has(property) || property === 'showInset') { setRenderSize(1); fitStage(); }
  if (REFIT.has(property)) refit();
  if (REGRADE.has(property)) regradeTextures();
  save();
}
function setSetting(key, value) {
  if (!(key in BASE)) throw new Error(`unknown setting "${key}"`);
  S[key] = value;
  settingChanged(key, value);
  refreshGui();
}

function buildGui() {
  const p = gui.addFolder('Path');
  layoutOnly.push([p.add(S, 'showInset').name('Show path'), ['overlay']]);
  p.addColor(S, 'pathColor').name('Color');
  p.add(S, 'pathWidth', 1, 16, 0.5).name('Width');
  p.add(S, 'futureStyle', { Dotted: 'dotted', Dashed: 'dashed', Solid: 'solid', Hidden: 'hidden' }).name('Path ahead');
  p.add(S, 'dashSize', 0.02, 0.4, 0.005).name('Spacing');
  p.add(S, 'futureOpacity', 0, 1, 0.05).name('Path ahead opacity');

  // the moving camera, the keyframes it leaves along the path, and the input photo's camera
  const c = gui.addFolder('Cameras');
  c.addColor(S, 'camColor').name('Camera color');
  c.add(S, 'camSize', 0.05, 2, 0.01).name('Camera size');
  c.add(S, 'camImage').name('Video in camera');
  c.add(S, 'keyframes', { Off: 'off', 'Along the path': 'all', 'Trail behind': 'trail' }).name('Keyframes');
  c.add(S, 'keyEvery', 2, 60, 1).name('Keyframe interval');
  c.addColor(S, 'keyColor').name('Keyframe color');
  c.add(S, 'keySize', 0.05, 2, 0.01).name('Keyframe size');
  c.add(S, 'inputCam').name('Input camera');
  c.addColor(S, 'inputColor').name('Input color');
  c.add(S, 'inputSize', 0.05, 2, 0.01).name('Input size');

  const v = gui.addFolder('View');
  const angle = v.add(ui, 'angle', { 'Choose…': '', 'Three-quarter': 'three-quarter', Side: 'side', Top: 'top', Behind: 'behind' })
    .name('Snap to angle')
    .onChange((a) => { if (a) { applyPreset(a); ui.angle = ''; angle.updateDisplay(); } });
  v.add(S, 'wiggle', { Off: 'off', Sway: 'sway', 'Figure-8': 'figure8', Circle: 'circle', Wigglegram: 'wigglegram' }).name('Wiggle');
  v.add(S, 'wiggleAmount', 0, 20, 0.5).name('Wiggle amount (°)');
  layoutOnly.push([v.add(S, 'insetCorner', { 'Bottom left': 'bottom-left', 'Bottom right': 'bottom-right', 'Top left': 'top-left', 'Top right': 'top-right' }).name('Inset corner'), ['overlay']]);
  layoutOnly.push([v.add(S, 'insetScale', 0.4, 1.8, 0.05).name('Inset size'), ['overlay']]);
  layoutOnly.push([v.add(S, 'insetMargin', 0, 300, 1).name('Inset margin (px)'), ['overlay']]);

  const pip = gui.addFolder('Output & input');
  pip.add(S, 'showOutput').name('Show output');
  pip.add(S, 'showInput').name('Show input');
  pip.add(S, 'pipCorner', { 'Top right': 'top-right', 'Bottom right': 'bottom-right', 'Top left': 'top-left', 'Bottom left': 'bottom-left' }).name('Position');
  pip.add(S, 'pipScale', 0.5, 1.6, 0.05).name('Size');
  layoutOnly.push([pip, ['world']]);

  const look = gui.addFolder('Adjustments');
  look.add(S, 'gradeBrightness', 0.5, 1.5, 0.01).name('Brightness');
  look.add(S, 'gradeContrast', 0.5, 1.5, 0.01).name('Contrast');
  look.add(S, 'gradeSaturation', 0, 2, 0.01).name('Saturation');
  look.add(S, 'vignette', 0, 1, 0.01).name('Vignette');
  layoutOnly.push([look.add(S, 'scrim', 0, 1.5, 0.01).name('Edge shading'), ['overlay']]);

  const t = gui.addFolder('Text');
  t.add(S, 'showHud').name('Show text');
  t.add(S, 'title').name('Title');
  t.add(S, 'subtitle').name('Subtitle');
  t.add(S, 'showStats').name('Camera stats');
  t.add(S, 'showProgress').name('Progress bar');
  t.add(S, 'showLabels').name('Labels');

  const s = gui.addFolder('Environment');      // background, floor and point cloud (both layouts)
  s.addColor(S, 'bg3d').name('Background');
  s.add(S, 'grid').name('Grid');
  s.add(S, 'gridY', -3, 3, 0.01).name('Floor height');
  s.add(actions, 'snapFloor').name('Snap floor to depth');
  s.add(S, 'cloud').name('Point cloud');
  s.add(S, 'cloudSize', 0.001, 0.06, 0.001).name('Point size');

  const e = gui.addFolder('Export');
  e.add(S, 'exportName').name('File name');
  e.add(actions, 'exportMp4').name('Export MP4');

  gui.onChange(({ property, value }) => { if (property in BASE) settingChanged(property, value); });
  for (const f of [v, pip, look, t, s, e]) f.close();  // Path and Cameras stay open
  picker.attach();
}

function afterLayoutChange() {
  picker.close();
  updateLayoutSeg();
  setRenderSize(1);
  fitStage();
  rebuildGrid();
  rebuildCloud();
  rebuildOverlay();
  regradeTextures();
  restoreView();
  refreshGui();
  save();
}
function switchLayout(l) {
  if (!LAYOUTS[l]) throw new Error(`unknown layout "${l}" (use "overlay" or "world")`);
  if (l === layout) return;
  store.per[layout] = { ...S };
  layout = l;
  loadLayoutSettings(l);
  if (T) afterLayoutChange();
  else { updateLayoutSeg(); save(); }
}
function updateLayoutSeg() {
  for (const b of $('layoutSeg').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.layout === layout));
    if (b.dataset.layout === layout) $('sideLayout').textContent = b.textContent.trim();   // "Style · <layout>"
  }
}
for (const b of $('layoutSeg').querySelectorAll('button')) b.onclick = () => switchLayout(b.dataset.layout);

// ---------------------------------------------------------- takes + import --

let takes = [], removable = new Set();   // removable: takes imported from a .zip
function openTake(name) {
  const q = new URLSearchParams(location.search);
  q.set('take', name);
  location.search = q;
}
function menuItem(label, { checked = false, action = false } = {}) {
  const b = document.createElement('button');
  b.className = `menu-item${action ? ' action' : ''}`;
  b.setAttribute('role', 'menuitem');
  b.innerHTML = `<span class="check">${checked ? '✓' : action ? '+' : ''}</span>`;
  b.append(label);
  return b;
}
function buildTakeMenu() {
  const m = $('takeMenu');
  m.replaceChildren();
  for (const name of takes) {
    const b = menuItem(name, { checked: name === T?.name });
    b.onclick = () => openTake(name);
    if (!removable.has(name)) { m.append(b); continue; }
    const row = Object.assign(document.createElement('div'), { className: 'menu-row' });
    const x = Object.assign(document.createElement('button'), { className: 'menu-remove', title: 'Remove this take' });
    x.setAttribute('aria-label', `Remove ${name}`);
    x.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 9h6.6l.7-9"/></svg>';
    x.onclick = (e) => { e.stopPropagation(); removeTake(name); };
    row.append(b, x);
    m.append(row);
  }
  if (takes.length) m.append(Object.assign(document.createElement('div'), { className: 'menu-sep' }));
  const imp = menuItem('Import Atlas export (.zip)…', { action: true });
  imp.onclick = () => { closeMenus(); $('fileInput').click(); };
  m.append(imp);
}
// the take menu and the export menu: one open at a time, closed by a click elsewhere or Escape
const MENUS = [['takeBtn', 'takeMenu'], ['exportMore', 'exportMenu']];
function closeMenus() {
  for (const [b, m] of MENUS) { $(m).hidden = true; $(b).setAttribute('aria-expanded', 'false'); }
}
for (const [b, m] of MENUS) {
  $(b).onclick = (e) => {
    e.stopPropagation();
    const open = $(m).hidden;
    closeMenus();
    $(m).hidden = !open;
    $(b).setAttribute('aria-expanded', String(open));
  };
}
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) closeMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

// A small in-page confirmation (the browser's own confirm() is blocked in some embedded browsers).
// Resolves true for the confirm button or Enter, false for Cancel, Escape or a click outside.
function ask(title, text, okLabel) {
  return new Promise((resolve) => {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmOk').textContent = okLabel;
    $('confirm').hidden = false;
    $('confirmOk').focus();
    const done = (answer) => {
      $('confirm').hidden = true;
      window.removeEventListener('keydown', onKey, true);
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(e.key === 'Enter'); }
    };
    window.addEventListener('keydown', onKey, true);
    $('confirmOk').onclick = () => done(true);
    $('confirmCancel').onclick = () => done(false);
    $('confirm').onclick = (e) => { if (e.target === $('confirm')) done(false); };
  });
}

// Deletes an imported take (its unpacked files and exports) after a confirmation.
async function removeTake(name) {
  closeMenus();
  const ok = await ask(`Remove “${name}”?`, 'This deletes the imported take and its exports. Your original .zip isn’t affected.', 'Remove');
  if (!ok) return;
  try {
    await postJSON(`/api/remove?take=${encodeURIComponent(name)}`, {});
  } catch (e) {
    toast(`Couldn't remove ${name}: ${e.message}`, 'error');
    return;
  }
  delete store.views[name];
  if (store.lastTake === name) delete store.lastTake;
  if (name === T?.name) {
    // the open take is gone: save now and go back to the start screen
    store.per[layout] = { ...S };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch {}
    location.href = location.pathname;
    return;
  }
  save();
  takes = takes.filter((t) => t !== name);
  removable.delete(name);
  buildTakeMenu();
  if (!$('welcome').hidden) showWelcome();   // refresh its list of takes
  toast(`Removed ${name}`);
}

// Uploads the .zip; the server unpacks it into the takes folder, then the new take opens.
function importZip(file) {
  if (!file) return;
  if (!/\.zip$/i.test(file.name)) { toast('Drop a .zip of an Atlas export.', 'error'); return; }
  pause();
  const label = `Importing ${file.name}`;
  showProgress(label, 0);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/import?name=${encodeURIComponent(file.name)}`);
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) showProgress(label, (e.loaded / e.total) * 0.9); };
  xhr.upload.onload = () => showProgress('Unpacking…', 0.95);
  xhr.onload = () => {
    let out = {};
    try { out = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status === 200 && out.take) { openTake(out.take); return; }
    hideProgress();
    toast(`Import failed: ${out.error || xhr.statusText}`, 'error');
  };
  xhr.onerror = () => { hideProgress(); toast('Import failed: the server didn’t respond.', 'error'); };
  xhr.send(file);
}
$('fileInput').onchange = (e) => { importZip(e.target.files[0]); e.target.value = ''; };
$('chooseBtn').onclick = () => $('fileInput').click();
let dragDepth = 0;
const dragging = (on) => {
  const welcome = !$('welcome').hidden;
  $('dropzone').classList.toggle('over', on && welcome);
  $('dropOverlay').classList.toggle('show', on && !welcome);
};
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  if (dragDepth++ === 0) dragging(true);
});
window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
window.addEventListener('dragleave', () => { if (dragDepth && --dragDepth === 0) dragging(false); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dragging(false);
  if (!exporting) importZip(e.dataTransfer.files[0]);
});

function showWelcome() {
  $('welcome').hidden = false;
  $('recent').hidden = !takes.length;
  $('recentList').replaceChildren(...takes.map((name) => {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => openTake(name);
    return b;
  }));
}

// -------------------------------------------------------------------- boot --

let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });

async function boot() {
  const params = new URLSearchParams(location.search);
  if (LAYOUTS[params.get('layout')]) layout = params.get('layout');
  loadLayoutSettings(layout);
  updateLayoutSeg();
  const info = await (await fetch('/api/takes')).json();
  takes = info.takes;
  removable = new Set(info.removable || []);
  buildTakeMenu();
  const want = params.get('take') ?? store.lastTake;
  if (!takes.includes(want)) {
    if (params.get('take')) toast(`Couldn't find the take "${params.get('take')}".`, 'error');
    showWelcome();
    return;
  }
  $('takeName').textContent = want;
  $('loading').hidden = false;
  await Promise.all([document.fonts.load(`600 20px ${SANS}`), document.fonts.load(`500 20px ${MONO}`)]).catch(() => {});
  await loadTake(want);
  store.lastTake = want;
  buildTakeMenu();
  $('loading').hidden = true;
  $('stageWrap').hidden = false;
  scrub.max = T.frames.length - 1;
  buildGui();
  afterLayoutChange();
  setFrame(0);
  for (const id of ['playBtn', 'exportBtn', 'exportMore']) $(id).disabled = false;
  if (!info.ffmpeg) {
    // without ffmpeg only snapshots work
    const videoExports = [$('exportBtn'), ...$('exportMenu').querySelectorAll('[data-export="mp4"], [data-export="alpha"]')];
    for (const el of videoExports) {
      el.disabled = true;
      el.title = 'Install ffmpeg (and restart the server) to export video';
    }
  }
  $('info').textContent = `${T.frames.length} frames · ${T.fps} fps · ${T.total.toFixed(2)} ${UNIT} path${T.depth ? ' · depth' : ''}`;
  if (!store.orbitHintSeen) hit.classList.add('teach');
  requestAnimationFrame(loop);
  readyResolve();
}
boot().catch((e) => {
  $('loading').hidden = true;
  toast(`Couldn't load: ${e.message}`, 'error');
  showWelcome();
  console.error(e);
});

// A small handle for scripts and agents driving the page (see README).
window.studio = {
  ready,                                              // resolves once a take is loaded
  get take() { return T?.name ?? null; },
  get layout() { return layout; },
  setLayout: switchLayout,                            // 'overlay' | 'world'
  setFrame: (i) => { pause(); setFrame(i); },
  set: setSetting,                                    // any side-panel setting, e.g. set('pathWidth', 8)
  exportVideo: ({ alpha = false } = {}) => exportVideo(alpha),   // resolves to the saved path
  snapshot,                                           // resolves to the saved path
};
