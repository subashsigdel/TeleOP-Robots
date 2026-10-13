/**
 * RobotLink — the ONLY seam between the dashboard UI and the robot.
 *
 * The UI never talks to WebRTC / ROS / the Unitree SDK directly. To go live,
 * write a class (e.g. WebRtcRobotLink) that extends RobotLink, emits the same
 * events and implements the same methods, then swap it in at the top of app.js.
 *
 * ── Events (listen with link.addEventListener(type, e => e.detail)) ──────────
 *   'connection'  { state: 'disconnected'|'connecting'|'connected'|'failed',
 *                   transport?: string, since?: Date, reason?: string }
 *   'video'       { id: string, name: string, label: string, stream: MediaStream|null,
 *                   width?: number, height?: number }
 *                 One event per camera (e.g. id 'front', 'rear'). stream: null = camera gone.
 *                 With 2+ cameras the Controls view shows a second feed instead of lidar.
 *   'telemetry'   Telemetry (see below) — any field may be omitted
 *   'pointcloud'  { points: Float32Array /* x,y,z,x,y,z… meters, robot frame
 *                   (x fwd, y left, z up, ground ≈ 0) *\/, stamp: number }
 *   'log'         { level: 'info'|'warn'|'error', source: string, message: string, time: Date }
 *
 * Telemetry = {
 *   battery:     { percent, voltage },
 *   cpu:         { percent, detail? },
 *   temperature: { max, avg },                    // °C, motors
 *   network:     { rttMs, rssi?, bitrateKbps? },
 *   legs:        { FL:{contact,force}, FR:{…}, RL:{…}, RR:{…} },
 *   velocity:    { vx, vy, wz },                  // measured, m/s & rad/s
 *   mode:        'stand_up'|'lie_down'|'balance'|'recovery'|'damp',
 * }
 *
 * ── Commands (called by the UI) ─────────────────────────────────────────────
 *   connect() / disconnect()
 *   sendVelocity({ vx, vy, wz })  sent at ~20 Hz while ARMED (acts as heartbeat;
 *                                 the robot side should stop if it goes quiet)
 *   sendMode(mode)                posture change, values as in Telemetry.mode
 *   setBodyHeight(offsetMeters)
 *   emergencyStop()
 */
export class RobotLink extends EventTarget {
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  connect() { throw new Error('not implemented'); }
  disconnect() { throw new Error('not implemented'); }
  sendVelocity(_cmd) {}
  sendMode(_mode) {}
  setBodyHeight(_h) {}
  emergencyStop() {}
}

/* ════════════════════════════════════════════════════════════════════════════
 * MockRobotLink — fake robot so the UI can be designed and tested offline.
 * Simulates a quadruped walking around a small scene: point cloud, a synthetic
 * camera feed (delivered as a real MediaStream, same as WebRTC would), telemetry
 * and logs. Delete once the real link exists.
 * ══════════════════════════════════════════════════════════════════════════ */
export class MockRobotLink extends RobotLink {
  constructor({ cameras = ['front'] } = {}) {
    super();
    this.cameraIds = cameras;
    this.streams = new Map();
    this.timers = [];
    this.pose = { x: 0, y: 0, yaw: 0, dist: 0 };
    this.cmd = { vx: 0, vy: 0, wz: 0 };
    this.lastCmdAt = 0;
    this.mode = 'lie_down';
    this.battery = 78;
    this.world = buildWorld();
    this.t0 = performance.now();
  }

  connect() {
    this.emit('connection', { state: 'connecting', transport: 'WebRTC (mock)' });
    const t = setTimeout(() => {
      this.connected = true;
      this.emit('connection', { state: 'connected', transport: 'WebRTC (mock)', since: new Date() });
      this.startupLogs();
      this.cameraIds.forEach(id => this.startVideo(id));
      this.every(50, () => this.stepSim(0.05));
      this.every(200, () => this.emitTelemetry());
      this.every(100, () => this.emitPointCloud());
      this.every(3500, () => this.randomLog());
    }, 900);
    this.timers.push({ clear: () => clearTimeout(t) });
  }

  disconnect() {
    this.timers.forEach(t => t.clear());
    this.timers = [];
    this.connected = false;
    for (const [id, stream] of this.streams) {
      stream.getTracks().forEach(t => t.stop());
      this.emit('video', { id, stream: null });
    }
    this.streams.clear();
    this.emit('connection', { state: 'disconnected' });
    this.log('warn', 'webrtc', 'Peer connection closed.');
  }

  sendVelocity(cmd) {
    this.cmd = cmd;
    this.lastCmdAt = performance.now();
  }

  sendMode(mode) {
    this.mode = mode;
    const names = { stand_up: 'StandUp', lie_down: 'StandDown', balance: 'BalanceStand', recovery: 'RecoveryStand' };
    this.log('info', 'sport_mode', `Mode → ${names[mode] ?? mode}.`);
  }

  setBodyHeight(h) {
    this.log('info', 'sport_mode', `Body height offset set to ${h.toFixed(2)} m.`);
  }

  emergencyStop() {
    this.mode = 'damp';
    this.cmd = { vx: 0, vy: 0, wz: 0 };
    this.log('error', 'safety', 'EMERGENCY STOP — motors damped.');
  }

  /* ── internals ── */
  every(ms, fn) {
    const id = setInterval(fn, ms);
    this.timers.push({ clear: () => clearInterval(id) });
  }

  log(level, source, message) {
    this.emit('log', { level, source, message, time: new Date() });
  }

  canWalk() { return this.mode === 'balance' || this.mode === 'stand_up' || this.mode === 'recovery'; }

  stepSim(dt) {
    // Deadman: no command for 300 ms → stop.
    const stale = performance.now() - this.lastCmdAt > 300;
    const c = stale || !this.canWalk() ? { vx: 0, vy: 0, wz: 0 } : this.cmd;
    const p = this.pose;
    p.yaw += c.wz * dt;
    const cos = Math.cos(p.yaw), sin = Math.sin(p.yaw);
    p.x += (c.vx * cos - c.vy * sin) * dt;
    p.y += (c.vx * sin + c.vy * cos) * dt;
    p.dist += Math.hypot(c.vx, c.vy) * dt;
    this.vel = c;
  }

  emitTelemetry() {
    const t = (performance.now() - this.t0) / 1000;
    const v = this.vel ?? { vx: 0, vy: 0, wz: 0 };
    const moving = Math.abs(v.vx) + Math.abs(v.vy) + Math.abs(v.wz) > 0.01;
    this.battery = Math.max(0, this.battery - (moving ? 0.004 : 0.001));
    const standing = this.mode !== 'lie_down' && this.mode !== 'damp';
    // Trot: diagonal pairs alternate while moving.
    const phase = Math.floor(t * 4) % 2 === 0;
    const leg = (pairA) => {
      const contact = !moving || !standing ? true : (pairA ? phase : !phase);
      return { contact, force: contact ? 38 + Math.random() * 14 : 0 };
    };
    this.emit('telemetry', {
      battery: { percent: this.battery, voltage: 25.2 + this.battery * 0.035 },
      cpu: { percent: 24 + Math.random() * 14 + (moving ? 10 : 0), detail: '6 cores · 1.8 GHz' },
      temperature: { max: 44 + Math.sin(t / 20) * 3 + (moving ? 4 : 0), avg: 39 + Math.sin(t / 20) * 2 },
      network: { rttMs: 42 + Math.random() * 30, rssi: -58 - Math.round(Math.random() * 8), bitrateKbps: 2400 + Math.random() * 600 },
      legs: { FL: leg(true), FR: leg(false), RL: leg(false), RR: leg(true) },
      velocity: v,
      mode: this.mode,
    });
  }

  emitPointCloud() {
    const { x: px, y: py, yaw } = this.pose;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const w = this.world, out = new Float32Array(w.length);
    let n = 0;
    for (let i = 0; i < w.length; i += 3) {
      const dx = w[i] - px, dy = w[i + 1] - py;
      const rx = dx * cos + dy * sin, ry = -dx * sin + dy * cos;
      if (rx * rx + ry * ry > 225) continue; // 15 m range
      if (Math.random() < 0.15) continue;     // dropout so it shimmers like a real scan
      out[n++] = rx + (Math.random() - 0.5) * 0.03;
      out[n++] = ry + (Math.random() - 0.5) * 0.03;
      out[n++] = w[i + 2] + (Math.random() - 0.5) * 0.02;
    }
    this.emit('pointcloud', { points: out.subarray(0, n), stamp: Date.now() });
  }

  startVideo(id) {
    const W = 1280, H = 720;
    const rear = id === 'rear';
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const draw = () => {
      if (!this.connected) return;
      const yaw = this.pose.yaw + (rear ? Math.PI : 0);
      const dist = rear ? -this.pose.dist : this.pose.dist;
      const horizon = H * 0.45;
      // sky
      let grad = g.createLinearGradient(0, 0, 0, horizon);
      grad.addColorStop(0, '#5f9bd8'); grad.addColorStop(1, '#cfe2f0');
      g.fillStyle = grad; g.fillRect(0, 0, W, horizon);
      // hills (parallax with yaw)
      const off = (((yaw * 600) % W) + W) % W;
      g.fillStyle = '#6d8a7a';
      g.beginPath(); g.moveTo(0, horizon);
      for (let x = -W; x <= 2 * W; x += 40) {
        g.lineTo(x + off, horizon - 40 - 30 * Math.sin((x) / 170) - 20 * Math.sin(x / 61));
      }
      g.lineTo(2 * W, horizon); g.fill();
      g.fillStyle = '#3f5f45';
      g.beginPath(); g.moveTo(0, horizon);
      for (let x = -W; x <= 2 * W; x += 30) {
        g.lineTo(x + off * 1.6, horizon - 14 - 18 * Math.abs(Math.sin(x / 47)));
      }
      g.lineTo(2 * W, horizon); g.fill();
      // ground
      grad = g.createLinearGradient(0, horizon, 0, H);
      grad.addColorStop(0, '#8b8a6a'); grad.addColorStop(1, '#6b6150');
      g.fillStyle = grad; g.fillRect(0, horizon, W, H - horizon);
      // perspective ground lines scrolling with distance travelled
      g.strokeStyle = 'rgba(40,35,25,.25)'; g.lineWidth = 2;
      for (let k = 0; k < 14; k++) {
        const z = 1 + k - ((((dist * 2) % 1) + 1) % 1);
        const y = horizon + (H - horizon) * (1 / z) * 0.9;
        g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      }
      for (let k = -8; k <= 8; k++) {
        g.beginPath(); g.moveTo(W / 2 + k * 30 + off * 0.2, horizon); g.lineTo(W / 2 + k * 260, H); g.stroke();
      }
      g.fillStyle = 'rgba(255,255,255,.55)';
      g.font = '500 22px "IBM Plex Mono", monospace';
      g.textAlign = 'center';
      g.fillText('SIMULATED FEED · MockRobotLink', W / 2, H * 0.7);
      g.textAlign = 'start';
      if (rear) g.fillText('REAR', W / 2, H * 0.7 + 34);
      requestAnimationFrame(draw);
    };
    draw();
    const stream = c.captureStream(30);
    this.streams.set(id, stream);
    const name = id[0].toUpperCase() + id.slice(1) + ' Camera';
    this.emit('video', { id, name, label: `cam_${id}`, stream, width: W, height: H });
  }

  startupLogs() {
    [
      ['info', 'webrtc', 'ICE connected (relay: none, host candidate).'],
      ['info', 'webrtc', 'Data channel "control" open.'],
      ...this.cameraIds.map(id => ['info', 'camera', `Video track received: cam_${id} 1280×720 H.264.`]),
      ['info', 'lidar', 'Publishing point cloud (10.0 Hz).'],
      ['info', 'battery', `Battery level at ${this.battery.toFixed(0)}%.`],
      ['info', 'sport_mode', 'Robot lying down. Select Stand or Balance to walk.'],
    ].forEach(([l, s, m]) => this.log(l, s, m));
  }

  randomLog() {
    const r = Math.random();
    if (r < 0.15) this.log('warn', 'obstacle', `Obstacle detected at ${(1 + Math.random() * 3).toFixed(1)} m (front).`);
    else if (r < 0.2) this.log('warn', 'webrtc', `Packet loss ${(1 + Math.random() * 3).toFixed(1)}% on video track.`);
    else if (r < 0.6) this.log('info', 'odom', `Pose x=${this.pose.x.toFixed(2)} y=${this.pose.y.toFixed(2)} yaw=${this.pose.yaw.toFixed(2)}.`);
    else this.log('info', 'battery', `Battery level at ${this.battery.toFixed(0)}%.`);
  }
}

/* Static scene for the mock lidar: ground, rocks, trees, a wall. */
function buildWorld() {
  let s = 7;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const pts = [];
  const ground = (x, y) => 0.06 * Math.sin(x * 0.5) + 0.05 * Math.cos(y * 0.7);
  for (let i = 0; i < 9000; i++) {
    const r = Math.sqrt(rand()) * 22, a = rand() * Math.PI * 2;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    pts.push(x, y, ground(x, y) + (rand() - 0.5) * 0.03);
  }
  const blob = (cx, cy, rx, ry, rz, n, z0 = ground(cx, cy), full = false) => {
    for (let i = 0; i < n; i++) {
      const u = rand() * Math.PI * 2, v = Math.acos(full ? 2 * rand() - 1 : rand()); // sphere or upper hemisphere
      pts.push(cx + rx * Math.sin(v) * Math.cos(u), cy + ry * Math.sin(v) * Math.sin(u), z0 + rz * Math.cos(v));
    }
  };
  [[6, -3, 1, .8, .9], [9, 4, 1.6, 1.4, 1.6], [4, 5, .7, .7, .5], [12, -6, 2.4, 2, 2.6], [-5, 4, 1.2, 1, 1], [-8, -6, 1.8, 1.4, 1.4], [3, -7, .9, .9, .7]]
    .forEach(([x, y, a, b, c]) => blob(x, y, a, b, c, Math.round(700 * a * b)));
  [[8, -1], [14, 2], [-3, -9], [-10, 1], [5, 11], [16, -10]].forEach(([x, y]) => {
    for (let i = 0; i < 160; i++) { const a = rand() * 6.28; pts.push(x + Math.cos(a) * .18, y + Math.sin(a) * .18, rand() * 1.8); }
    blob(x, y, 1.0, 1.0, 1.1, 900, 2.2, true);
  });
  for (let i = 0; i < 2600; i++) pts.push(18, -12 + rand() * 24, rand() * 2.6);
  return new Float32Array(pts);
}
