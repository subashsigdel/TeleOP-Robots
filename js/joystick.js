/**
 * Joystick — circular drag pad. Exposes x (right +) and y (up +) in [-1, 1].
 * Releasing the pointer snaps back to centre (0, 0) — a natural deadman.
 */
export class Joystick {
  constructor(pad, knob) {
    this.pad = pad;
    this.knob = knob;
    this.x = 0;
    this.y = 0;
    this.active = false;
    this.enabled = false;

    pad.addEventListener('pointerdown', e => {
      if (!this.enabled || e.target.closest('[data-dir]')) return;
      this.active = true;
      pad.classList.add('dragging');
      pad.setPointerCapture(e.pointerId);
      this.update(e);
    });
    pad.addEventListener('pointermove', e => { if (this.active) this.update(e); });
    pad.addEventListener('pointerup', () => this.release());
    pad.addEventListener('pointercancel', () => this.release());
  }

  setEnabled(on) {
    this.enabled = on;
    this.pad.classList.toggle('disabled', !on);
    if (!on) this.release();
  }

  update(e) {
    const r = this.pad.getBoundingClientRect();
    const radius = (r.width / 2) * 0.62;
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > radius) { dx *= radius / len; dy *= radius / len; }
    this.x = dx / radius;
    this.y = -dy / radius;
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  release() {
    this.active = false;
    this.x = this.y = 0;
    this.pad.classList.remove('dragging');
    this.knob.style.transform = '';
  }
}
