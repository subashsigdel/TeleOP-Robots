/**
 * LidarView — lightweight orbit-camera point cloud renderer on a 2D canvas.
 * Points are robot-frame (x forward, y left, z up). Coloured by height.
 * No dependencies; handles ~30k points per frame comfortably. If clouds get
 * much denser, swap this for a three.js / WebGL renderer with the same API.
 */
const Z_MAX = 3.0;
const DEFAULT_VIEW = { yaw: -0.5, pitch: 0.45, dist: 10, target: [2.5, 0, 0] };

export class LidarView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.points = new Float32Array(0);
    this.view = structuredClone(DEFAULT_VIEW);
    this.palette = buildPalette(64);
    this.dirty = true;

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.bindInput();
    const loop = () => { if (this.dirty) this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  setPoints(points) { this.points = points; this.dirty = true; }
  resetView() { this.view = structuredClone(DEFAULT_VIEW); this.dirty = true; }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.dpr = dpr;
    this.dirty = true;
  }

  bindInput() {
    const c = this.canvas.parentElement;
    let drag = null;
    c.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => {
      if (!drag) return;
      this.view.yaw -= (e.clientX - drag.x) * 0.008;
      this.view.pitch = clamp(this.view.pitch + (e.clientY - drag.y) * 0.006, 0.05, 1.45);
      drag = { x: e.clientX, y: e.clientY };
      this.dirty = true;
    });
    const end = () => { drag = null; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.view.dist = clamp(this.view.dist * Math.exp(e.deltaY * 0.001), 2, 40);
      this.dirty = true;
    }, { passive: false });
    c.addEventListener('dblclick', () => this.resetView());
  }

  /* Returns [sx, sy, depth] or null when behind the camera. */
  makeProjector() {
    const { yaw, pitch, dist, target } = this.view;
    const W = this.canvas.width, H = this.canvas.height;
    const f = Math.min(W, H) * 1.1;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const [tx, ty, tz] = target;
    const cx0 = W / 2, cy0 = H * 0.55;
    return (x, y, z) => {
      x -= tx; y -= ty; z -= tz;
      const d = x * cy + y * sy;          // forward along view
      const r = x * sy - y * cy;          // screen right
      const depth = d * cp - z * sp + dist;
      if (depth < 0.2) return null;
      const up = d * sp + z * cp;
      return [cx0 + (f * r) / depth, cy0 - (f * up) / depth, depth];
    };
  }

  draw() {
    this.dirty = false;
    const { ctx: g, canvas } = this;
    const W = canvas.width, H = canvas.height, dpr = this.dpr || 1;
    g.fillStyle = '#0e1014';
    g.fillRect(0, 0, W, H);
    const P = this.makeProjector();

    // ground grid
    g.lineWidth = 1 * dpr;
    g.strokeStyle = 'rgba(120, 140, 135, .16)';
    g.beginPath();
    // short segments so lines crossing behind the camera are clipped, not dropped
    for (let k = -14; k <= 14; k += 1) {
      for (let s = -14; s < 14; s += 1) {
        line(g, P, k, s, 0, k, s + 1, 0);
        line(g, P, s, k, 0, s + 1, k, 0);
      }
    }
    g.stroke();

    // points, bucketed by colour to keep fillStyle changes cheap
    const pts = this.points, pal = this.palette, n = pal.length;
    const buckets = Array.from({ length: n }, () => []);
    for (let i = 0; i < pts.length; i += 3) {
      const p = P(pts[i], pts[i + 1], pts[i + 2]);
      if (!p) continue;
      const ci = Math.max(0, Math.min(n - 1, Math.floor((pts[i + 2] / Z_MAX) * n)));
      buckets[ci].push(p[0], p[1], p[2]);
    }
    for (let ci = 0; ci < n; ci++) {
      const b = buckets[ci];
      if (!b.length) continue;
      g.fillStyle = pal[ci];
      for (let j = 0; j < b.length; j += 3) {
        const s = Math.max(1, Math.min(3.2, 26 / b[j + 2])) * dpr * 0.75;
        g.fillRect(b[j] - s / 2, b[j + 1] - s / 2, s, s);
      }
    }

    // robot body (rough quadruped footprint) + axes
    g.strokeStyle = 'rgba(230, 236, 234, .85)';
    g.lineWidth = 1.4 * dpr;
    g.beginPath();
    box(g, P, -0.35, -0.15, 0.25, 0.35, 0.15, 0.42);
    for (const [lx, ly] of [[0.25, 0.15], [0.25, -0.15], [-0.25, 0.15], [-0.25, -0.15]]) line(g, P, lx, ly, 0.25, lx, ly, 0);
    g.stroke();
    axis(g, P, [1, 0, 0], '#ff4d42', 'X', dpr);
    axis(g, P, [0, 1, 0], '#3ddc6a', 'Y', dpr);
    axis(g, P, [0, 0, 1], '#3f8cff', 'Z', dpr);
  }
}

function line(g, P, x1, y1, z1, x2, y2, z2) {
  const a = P(x1, y1, z1), b = P(x2, y2, z2);
  if (!a || !b) return;
  g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
}

function box(g, P, x0, y0, z0, x1, y1, z1) {
  const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = c[i], [bx, by] = c[(i + 1) % 4];
    line(g, P, ax, ay, z0, bx, by, z0);
    line(g, P, ax, ay, z1, bx, by, z1);
    line(g, P, ax, ay, z0, ax, ay, z1);
  }
}

function axis(g, P, dir, color, label, dpr) {
  const o = P(0, 0, 0.45), e = P(dir[0] * 1.1, dir[1] * 1.1, 0.45 + dir[2] * 1.1);
  if (!o || !e) return;
  g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 2 * dpr;
  g.beginPath(); g.moveTo(o[0], o[1]); g.lineTo(e[0], e[1]); g.stroke();
  g.font = `600 ${11 * dpr}px "IBM Plex Mono", monospace`;
  g.fillText(label, e[0] + 4 * dpr, e[1] - 4 * dpr);
}

/* Jet-like ramp matching the colour bar: blue → cyan → green → yellow → red. */
function buildPalette(n) {
  const stops = [[42, 31, 214], [31, 140, 240], [24, 224, 200], [125, 234, 61], [244, 225, 27], [242, 120, 26], [224, 40, 27]];
  return Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1)) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
    const [r, g, b] = stops[k].map((v, j) => Math.round(v + (stops[k + 1][j] - v) * f));
    return `rgb(${r},${g},${b})`;
  });
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
