import { MockRobotLink } from './robot-link.js';
import { LidarView } from './lidar-view.js';
import { Joystick } from './joystick.js';

/* ─────────────── Config (fill in once the exact Unitree model is known) ─────────────── */
const CONFIG = {
  robotName: 'ROVER-01',
  model: 'Unitree · model TBD',
  maxSpeed: 1.5,        // m/s — upper bound of the speed slider
  maxYawRate: 1.5,      // rad/s at full stick
  strafeRatio: 0.6,     // lateral speed as a fraction of max speed
  commandHz: 20,
};

// ← Swap for the real WebRTC implementation (same events + methods, see robot-link.js).
// ?cams=2 makes the mock expose a front + rear camera to preview the multi-camera layout.
const link = new MockRobotLink({
  cameras: new URLSearchParams(location.search).get('cams') === '2' ? ['front', 'rear'] : ['front'],
});

/* ─────────────── Helpers ─────────────── */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const pad2 = (n) => String(n).padStart(2, '0');
const hms = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const clamp1 = (v) => Math.max(-1, Math.min(1, v));
const MODE_NAMES = { stand_up: 'Standing', lie_down: 'Lying down', balance: 'Balance stand', recovery: 'Recovery', damp: 'Damped (E-stop)' };

const state = {
  conn: 'disconnected',
  armed: false,
  estop: false,
  maxSpeed: 0.5,
  mode: null,
  keys: new Set(),
  held: new Set(),     // on-screen direction buttons being held
  logs: [],
  logFilter: 'all',
};

/* ─────────────── Static labels ─────────────── */
$('#tbName').textContent = CONFIG.robotName;
$('#sbRobot').textContent = CONFIG.robotName;
$('#sbModel').textContent = CONFIG.model;

/* ─────────────── Navigation ─────────────── */
function showView(view) {
  const btn = document.querySelector(`.nav-item[data-view="${view}"]`) ?? document.querySelector('.nav-item');
  $$('.nav-item').forEach(b => b.classList.toggle('active', b === btn));
  $('#app').dataset.view = btn.dataset.view;
}
// Views are linkable: …/#controls opens the driving screen directly.
$$('.nav-item').forEach(btn => btn.addEventListener('click', () => { location.hash = btn.dataset.view; }));
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
showView(location.hash.slice(1));

/* ─────────────── Clock ─────────────── */
function tickClock() {
  const d = new Date();
  $('#tbDate').textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  $('#tbTime').textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
tickClock();
setInterval(tickClock, 1000);

/* ─────────────── Connection ─────────────── */
$('#connectBtn').addEventListener('click', () => {
  if (state.conn === 'connected' || state.conn === 'connecting') link.disconnect();
  else link.connect();
});

link.addEventListener('connection', ({ detail }) => {
  state.conn = detail.state;
  const connected = detail.state === 'connected';
  const dotCls = { connected: 'ok', connecting: 'warn pulse', failed: 'err' }[detail.state] ?? '';
  for (const id of ['#tbDot', '#sbDot']) $(id).className = `dot ${dotCls}`;

  const pill = $('#tbPill');
  pill.textContent = { connected: 'Online', connecting: 'Connecting…', failed: 'Failed' }[detail.state] ?? 'Offline';
  pill.className = `pill ${connected ? '' : detail.state === 'connecting' ? 'warn' : 'off'}`;

  $('#sbState').textContent = pill.textContent === 'Online' ? 'Connected' : pill.textContent;
  $('#sbTransport').textContent = detail.transport ?? 'WebRTC · —';
  $('#connTransport').textContent = detail.transport ?? '—';
  $('#connState').textContent = detail.state;
  if (detail.since) $('#tbSince').textContent = hms(detail.since);
  if (!connected) { $('#tbSince').textContent = '--:--:--'; $('#tbRtt').textContent = '— ms'; }

  const btn = $('#connectBtn');
  btn.textContent = connected ? 'Disconnect' : detail.state === 'connecting' ? 'Cancel' : 'Connect';
  btn.classList.toggle('primary', !connected && detail.state !== 'connecting');

  $('#lidarDot').className = `dot ${connected ? 'ok' : ''}`;
  $('#lidarState').textContent = connected ? 'Live' : 'Idle';
  if (!connected) { setArmed(false); lidar.setPoints(new Float32Array(0)); }
  $('#armToggle').disabled = !connected;
  updateControlsEnabled();
});

/* ─────────────── Video (any number of cameras) ─────────────── */
const video = $('#video');
let frameCount = 0;
const cameras = new Map();   // id → { name, label, stream, width, height }
const viewers = [
  { video, empty: $('#videoEmpty'), hud: $('#hud'), label: $('#hudLabel'), select: $('#camSelect'), camId: null },
  { video: $('#video2'), empty: $('#video2Empty'), hud: $('#hud2'), label: $('#hud2Label'), select: $('#cam2Select'), camId: null },
];

link.addEventListener('video', ({ detail }) => {
  if (detail.stream) cameras.set(detail.id, detail);
  else cameras.delete(detail.id);
  refreshCameras();
});

function refreshCameras() {
  const ids = [...cameras.keys()];
  viewers.forEach((v, i) => {
    // Default: viewer N shows camera N (so viewer 2 shows a *different* camera).
    // Once the user picks a camera from the dropdown, keep it while it exists.
    if (!v.picked || !cameras.has(v.camId)) { v.camId = ids[i] ?? ids[0] ?? null; v.picked = false; }
    v.select.replaceChildren(...ids.map(id => new Option(cameras.get(id).name ?? id, id, false, id === v.camId)));
    v.select.disabled = ids.length < 2;
    attachViewer(v);
  });
  // 2+ cameras → the Controls view shows a second camera instead of the lidar
  $('#app').classList.toggle('multi-cam', ids.length > 1);
  if (!ids.length) { $('#fpsVal').textContent = '—'; $('#fpsDot').className = 'dot'; }
}

function attachViewer(v) {
  const cam = cameras.get(v.camId);
  if (v.video.srcObject !== (cam?.stream ?? null)) v.video.srcObject = cam?.stream ?? null;
  v.empty.hidden = !!cam;
  v.hud.style.display = cam ? '' : 'none';
  v.label.textContent = cam ? `${cam.label}${cam.width ? ` · ${cam.width}×${cam.height}` : ''}` : '—';
}

viewers.forEach(v => v.select.addEventListener('change', () => { v.camId = v.select.value; v.picked = true; attachViewer(v); }));
refreshCameras();

// FPS from actually-presented frames (works the same for a WebRTC track).
if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
  const onFrame = () => { frameCount++; video.requestVideoFrameCallback(onFrame); };
  video.requestVideoFrameCallback(onFrame);
  setInterval(() => {
    if (!video.srcObject) return;
    $('#fpsVal').textContent = frameCount.toFixed(1);
    $('#fpsDot').className = `dot ${frameCount > 20 ? 'ok' : frameCount > 8 ? 'warn' : 'err'}`;
    frameCount = 0;
  }, 1000);
}

$('#hudBtn').addEventListener('click', () => $('#hud').classList.toggle('hidden'));
$('#fullBtn').addEventListener('click', () => {
  const vp = $('#videoVp');
  document.fullscreenElement ? document.exitFullscreen() : vp.requestFullscreen?.();
});

/* ─────────────── Lidar ─────────────── */
const lidar = new LidarView($('#lidarCanvas'));
$('#lidarReset').addEventListener('click', () => lidar.resetView());
let cloudCount = 0;
link.addEventListener('pointcloud', ({ detail }) => {
  lidar.setPoints(detail.points);
  cloudCount++;
  $('#lidarPts').textContent = (detail.points.length / 3).toLocaleString();
});
setInterval(() => {
  $('#lidarHz').textContent = state.conn === 'connected' ? (cloudCount / 2).toFixed(1) : '—';
  cloudCount = 0;
}, 2000);

/* ─────────────── Controls ─────────────── */
const joy = new Joystick($('#pad'), $('#knob'));

function setArmed(on) {
  state.armed = on && state.conn === 'connected' && !state.estop;
  $('#armToggle').checked = state.armed;
  $('#armLabel').textContent = state.armed ? 'Armed' : 'Disarmed';
  $('#connCtrl').textContent = state.estop ? 'E-stopped' : state.armed ? 'Armed' : 'Disarmed';
  updateControlsEnabled();
}

function updateControlsEnabled() {
  const on = state.armed;
  joy.setEnabled(on);
  $$('#modeSeg button').forEach(b => { b.disabled = state.conn !== 'connected' || state.estop; });
  if (!on) { state.held.clear(); $$('[data-dir].held').forEach(b => b.classList.remove('held')); }
}

$('#armToggle').addEventListener('change', (e) => {
  setArmed(e.target.checked);
  addLog('info', 'ui', state.armed ? 'Teleop armed — velocity commands enabled.' : 'Teleop disarmed.');
});

// Press-and-hold direction buttons (D-pad + strafe)
$$('[data-dir]').forEach(btn => {
  const dir = btn.dataset.dir;
  const down = (e) => {
    if (!state.armed) return;
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    state.held.add(dir); btn.classList.add('held');
  };
  const up = () => { state.held.delete(dir); btn.classList.remove('held'); };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('lostpointercapture', up);
});

// Sliders
function paintRange(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}
const speed = $('#speed');
speed.max = CONFIG.maxSpeed;
speed.addEventListener('input', () => {
  state.maxSpeed = +speed.value;
  $('#speedVal').textContent = `${state.maxSpeed.toFixed(2)} m/s`;
  paintRange(speed);
});
const height = $('#height');
height.addEventListener('input', () => {
  const h = +height.value;
  $('#heightVal').textContent = `${h >= 0 ? '+' : '−'}${Math.abs(h).toFixed(2)} m`;
  paintRange(height);
});
height.addEventListener('change', () => { if (state.conn === 'connected') link.setBodyHeight(+height.value); });
speed.dispatchEvent(new Event('input'));
height.dispatchEvent(new Event('input'));

// Posture modes
$$('#modeSeg button').forEach(b => b.addEventListener('click', () => link.sendMode(b.dataset.mode)));

// Emergency stop
function triggerEstop() {
  if (state.conn !== 'connected') return;
  state.estop = true;
  link.emergencyStop();
  setArmed(false);
  renderEstop();
}
function releaseEstop() {
  state.estop = false;
  addLog('warn', 'ui', 'E-stop released. Re-arm and choose a posture to continue.');
  setArmed(false);
  renderEstop();
}
function renderEstop() {
  $('#estopBtn').classList.toggle('active', state.estop);
  $('#estopLabel').textContent = state.estop ? 'E-Stop active · release' : 'Emergency Stop';
  $('#videoVp').classList.toggle('estopped', state.estop);
}
$('#estopBtn').addEventListener('click', () => state.estop ? releaseEstop() : triggerEstop());

// Keyboard
const KEYMAP = { KeyW: 'fwd', ArrowUp: 'fwd', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', KeyQ: 'strafeL', KeyE: 'strafeR' };
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
  if (e.code === 'Escape') { triggerEstop(); return; }
  if (e.code === 'Space') { e.preventDefault(); state.keys.clear(); joy.release(); return; }
  if (KEYMAP[e.code] && state.armed) { e.preventDefault(); state.keys.add(KEYMAP[e.code]); }
});
window.addEventListener('keyup', (e) => state.keys.delete(KEYMAP[e.code]));
// Losing focus must never leave a key "stuck" down.
window.addEventListener('blur', () => { state.keys.clear(); state.held.clear(); joy.release(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { state.keys.clear(); joy.release(); } });

function currentCommand() {
  const has = (d) => state.keys.has(d) || state.held.has(d);
  const fwd = clamp1(joy.y + has('fwd') - has('back'));
  const turn = clamp1(joy.x + has('right') - has('left'));       // + = turn right
  const strafe = clamp1(has('strafeL') - has('strafeR'));        // + = left (ROS)
  const k = state.maxSpeed / CONFIG.maxSpeed;
  return {
    vx: fwd * state.maxSpeed,
    vy: strafe * state.maxSpeed * CONFIG.strafeRatio,
    wz: -turn * CONFIG.maxYawRate * Math.max(0.3, k),
  };
}

// Command loop — streams at a fixed rate while armed (doubles as heartbeat).
setInterval(() => {
  const cmd = state.armed ? currentCommand() : { vx: 0, vy: 0, wz: 0 };
  if (state.armed) link.sendVelocity(cmd);
  const moving = Math.abs(cmd.vx) + Math.abs(cmd.vy) + Math.abs(cmd.wz) > 1e-3;
  $('#cmdText').textContent = state.estop ? 'E-stop' : !state.armed ? 'Idle (disarmed)' : moving ? describe(cmd) : 'Stop';
}, 1000 / CONFIG.commandHz);

function describe({ vx, vy, wz }) {
  const parts = [];
  if (Math.abs(vx) > 1e-3) parts.push(vx > 0 ? 'Forward' : 'Backward');
  if (Math.abs(vy) > 1e-3) parts.push(vy > 0 ? 'Strafe L' : 'Strafe R');
  if (Math.abs(wz) > 1e-3) parts.push(wz > 0 ? 'Turn L' : 'Turn R');
  return parts.join(' + ');
}

/* ─────────────── Telemetry ─────────────── */
function setBar(id, pct, warnAt, errAt, invert = false) {
  const bar = $(id);
  bar.firstElementChild.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  const bad = invert ? pct <= errAt : pct >= errAt;
  const meh = invert ? pct <= warnAt : pct >= warnAt;
  bar.className = `bar ${bad ? 'err' : meh ? 'warn' : ''}`;
}

link.addEventListener('telemetry', ({ detail: t }) => {
  if (t.battery) {
    $('#batVal').textContent = `${t.battery.percent.toFixed(0)}%`;
    $('#batSub').textContent = `${t.battery.voltage.toFixed(1)} V`;
    setBar('#batBar', t.battery.percent, 30, 15, true);
  }
  if (t.cpu) {
    $('#cpuVal').textContent = `${t.cpu.percent.toFixed(0)}%`;
    $('#cpuSub').textContent = t.cpu.detail ?? '';
    setBar('#cpuBar', t.cpu.percent, 75, 90);
  }
  if (t.temperature) {
    const m = t.temperature.max;
    $('#tempVal').textContent = `${m.toFixed(0)}°C`;
    $('#tempSub').textContent = `${m >= 70 ? 'Hot' : m >= 58 ? 'Warm' : 'Normal'} · avg ${t.temperature.avg.toFixed(0)}°C`;
    setBar('#tempBar', (m / 90) * 100, 64, 78);
  }
  if (t.network) {
    const rtt = t.network.rttMs;
    $('#netRtt').textContent = `${rtt.toFixed(0)} ms`;
    $('#tbRtt').textContent = `${rtt.toFixed(0)} ms`;
    $('#hudLatency').textContent = `RTT ${rtt.toFixed(0)} ms`;
    $('#netRssi').textContent = t.network.rssi != null ? `${t.network.rssi} dBm` : '—';
    $('#netBitrate').textContent = t.network.bitrateKbps != null ? `${(t.network.bitrateKbps / 1000).toFixed(1)} Mbps` : '—';
    const bars = rtt < 60 ? 4 : rtt < 120 ? 3 : rtt < 250 ? 2 : 1;
    $$('#tbSignal i').forEach((b, i) => b.classList.toggle('on', i < bars));
  }
  if (t.legs) {
    for (const [leg, v] of Object.entries(t.legs)) {
      const el = document.querySelector(`[data-leg="${leg}"]`);
      if (!el) continue;
      el.querySelector('.dot').className = `dot ${v.contact ? 'ok' : ''}`;
      el.querySelector('.muted').textContent = v.contact ? `${v.force.toFixed(0)} N` : 'swing';
    }
  }
  if (t.velocity) {
    const { vx, vy, wz } = t.velocity;
    $('#velText').textContent = `vx ${vx.toFixed(2)} · vy ${vy.toFixed(2)} · wz ${wz.toFixed(2)}`;
    $('#hudVel').textContent = `${Math.hypot(vx, vy).toFixed(2)} m/s · ${wz.toFixed(2)} rad/s`;
  }
  if (t.mode && t.mode !== state.mode) {
    state.mode = t.mode;
    $('#driveMode').textContent = `Manual · ${MODE_NAMES[t.mode] ?? t.mode}`;
    $$('#modeSeg button').forEach(b => b.classList.toggle('active', b.dataset.mode === t.mode));
  }
});

/* ─────────────── Logs ─────────────── */
const logList = $('#logList');
function addLog(level, source, message, time = new Date()) {
  state.logs.unshift({ level, source, message, time });
  if (state.logs.length > 500) state.logs.pop();
  renderLogs();
}
function renderLogs() {
  const rows = state.logs.filter(l => state.logFilter === 'all' || l.level === state.logFilter);
  if (!rows.length) { logList.innerHTML = '<li class="empty">No log entries</li>'; return; }
  const frag = document.createDocumentFragment();
  for (const l of rows.slice(0, 200)) {
    const li = document.createElement('li');
    li.className = `lvl-${l.level}`;
    li.innerHTML = `<span class="dot"></span><span>${hms(l.time)}</span><span class="lvl">[${l.level.toUpperCase()}]</span><span class="src"></span><span class="msg"></span>`;
    li.querySelector('.src').textContent = `[${l.source}]`;
    li.querySelector('.msg').textContent = l.message;
    frag.appendChild(li);
  }
  logList.replaceChildren(frag);
}
link.addEventListener('log', ({ detail: l }) => addLog(l.level, l.source, l.message, l.time));
$$('#logFilters .chip').forEach(c => c.addEventListener('click', () => {
  state.logFilter = c.dataset.level;
  $$('#logFilters .chip').forEach(x => x.classList.toggle('active', x === c));
  renderLogs();
}));
$('#logClear').addEventListener('click', () => { state.logs = []; renderLogs(); });

/* ─────────────── Boot ─────────────── */
addLog('info', 'ui', 'Dashboard ready. Press Connect to open a session.');
setArmed(false);
renderEstop();
// ?demo → auto-connect the mock (handy for screenshots / quick previews)
if (new URLSearchParams(location.search).has('demo')) link.connect();
