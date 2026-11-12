/**
 * Player input: keyboard (physical keys via KeyboardEvent.code, so WASD is ZQSD on AZERTY) and
 * pointer drag (mouse or touch, relative movement; holding the pointer down also fires).
 */
import type { PlayInput } from './play';

const LEFT = ['KeyA', 'ArrowLeft'], RIGHT = ['KeyD', 'ArrowRight'], UP = ['KeyW', 'ArrowUp'], DOWN = ['KeyS', 'ArrowDown'];
const FIRE = ['KeyJ', 'KeyK', 'KeyZ'];
const FOCUS = ['ShiftLeft', 'ShiftRight'];
export const GAME_KEYS = new Set([...LEFT, ...RIGHT, ...UP, ...DOWN, ...FIRE, ...FOCUS]);

export class Input {
  private down = new Set<string>();
  private pointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private dragX = 0;
  private dragY = 0;
  /** Screen px → arena px. */
  scale = 1;
  enabled = false;

  constructor(host: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || !GAME_KEYS.has(e.code) || isFormField(e.target)) return;
      this.down.add(e.code);
      e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.down.delete(e.code); });
    window.addEventListener('blur', () => { this.down.clear(); this.pointerId = null; });

    host.addEventListener('pointerdown', (e) => {
      if (!this.enabled || this.pointerId != null) return;
      this.pointerId = e.pointerId;
      this.lastX = e.clientX; this.lastY = e.clientY;
      host.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    host.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.pointerId) return;
      this.dragX += e.clientX - this.lastX;
      this.dragY += e.clientY - this.lastY;
      this.lastX = e.clientX; this.lastY = e.clientY;
    });
    const up = (e: PointerEvent) => { if (e.pointerId === this.pointerId) this.pointerId = null; };
    host.addEventListener('pointerup', up);
    host.addEventListener('pointercancel', up);
  }

  private any(codes: string[]) { return codes.some((c) => this.down.has(c)); }

  /** Read and consume this frame's input. */
  read(): PlayInput {
    const s = this.scale || 1;
    const out: PlayInput = {
      mx: (this.any(RIGHT) ? 1 : 0) - (this.any(LEFT) ? 1 : 0),
      my: (this.any(DOWN) ? 1 : 0) - (this.any(UP) ? 1 : 0),
      dragX: this.dragX / s,
      dragY: this.dragY / s,
      focus: this.any(FOCUS),
      fire: this.any(FIRE) || this.pointerId != null,
    };
    this.dragX = 0; this.dragY = 0;
    return out;
  }
}

function isFormField(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'checkbox'));
}
