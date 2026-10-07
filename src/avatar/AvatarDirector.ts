import type { Emotion, Gaze, Gesture, PerformanceCue } from '../core/types';
import { sampleLipSync, type LipSyncKeyframe } from '../core/voice/LipSync';

/**
 * Turns high-level PerformanceCues (from the LLM, every few seconds) into
 * 60 fps parameter values (design doc §12). The LLM never produces
 * per-frame coordinates.
 */
export const PARAMS = [
  'ParamAngleX',
  'ParamAngleY',
  'ParamAngleZ',
  'ParamEyeLOpen',
  'ParamEyeROpen',
  'ParamEyeLSmile',
  'ParamEyeRSmile',
  'ParamEyeBallX',
  'ParamEyeBallY',
  'ParamBrowLY',
  'ParamBrowRY',
  'ParamMouthOpenY',
  'ParamMouthForm',
  'ParamCheek',
  'ParamBodyAngleX',
  'ParamBodyAngleY',
  'ParamBodyAngleZ',
  'ParamBreath',
  'ParamBaseX',
  'ParamBaseY',
  'ParamGlassesBounce',
  'ParamGlassesTilt',
  'ParamShoulderY',
  'ParamShoulderX',
  'ParamHeadBob',
  'ParamIdleEnergy',
  'ParamEmotionWeight',
] as const;
export type ParamName = (typeof PARAMS)[number];
export type ParamValues = Record<ParamName, number>;

type Partial2<T> = { [K in keyof T]?: T[K] };

function zeroParams(): ParamValues {
  const p = {} as ParamValues;
  for (const k of PARAMS) p[k] = 0;
  p.ParamEyeLOpen = 1;
  p.ParamEyeROpen = 1;
  return p;
}

/** Full-intensity expression poses, blended by intensity. */
export const EXPRESSIONS: Record<Emotion, Partial2<ParamValues>> = {
  neutral: {},
  smile: { ParamEyeLSmile: 0.5, ParamEyeRSmile: 0.5, ParamMouthForm: 0.6 },
  happy: { ParamEyeLSmile: 0.9, ParamEyeRSmile: 0.9, ParamMouthForm: 1, ParamBrowLY: 0.3, ParamBrowRY: 0.3, ParamIdleEnergy: 0.6 },
  embarrassed: { ParamCheek: 1, ParamEyeLOpen: 0.75, ParamEyeROpen: 0.75, ParamEyeBallY: -0.4, ParamMouthForm: -0.2, ParamAngleY: -6 },
  worried: { ParamBrowLY: -0.5, ParamBrowRY: -0.5, ParamMouthForm: -0.5, ParamEyeLOpen: 0.9, ParamEyeROpen: 0.9 },
  concerned: { ParamBrowLY: -0.35, ParamBrowRY: -0.35, ParamMouthForm: -0.3 },
  unimpressed: { ParamEyeLOpen: 0.45, ParamEyeROpen: 0.45, ParamMouthForm: -0.3, ParamBrowLY: -0.1, ParamBrowRY: -0.1, ParamIdleEnergy: -0.5 },
  annoyed: { ParamBrowLY: -0.8, ParamBrowRY: -0.8, ParamEyeLOpen: 0.7, ParamEyeROpen: 0.7, ParamMouthForm: -0.7 },
  tired: { ParamEyeLOpen: 0.55, ParamEyeROpen: 0.55, ParamAngleY: -5, ParamShoulderY: -0.4, ParamIdleEnergy: -0.8 },
  sad: { ParamBrowLY: -0.6, ParamBrowRY: -0.6, ParamMouthForm: -0.8, ParamAngleY: -8, ParamEyeBallY: -0.3 },
  smug: { ParamEyeLOpen: 0.7, ParamEyeROpen: 0.7, ParamMouthForm: 0.8, ParamAngleZ: 4, ParamBrowLY: 0.2 },
  surprised: { ParamEyeLOpen: 1.25, ParamEyeROpen: 1.25, ParamBrowLY: 0.9, ParamBrowRY: 0.9, ParamMouthOpenY: 0.4, ParamShoulderY: 0.3 },
  focused: { ParamEyeLOpen: 0.85, ParamEyeROpen: 0.85, ParamBrowLY: -0.2, ParamBrowRY: -0.2, ParamIdleEnergy: -0.3 },
  confused: { ParamBrowLY: 0.4, ParamBrowRY: -0.4, ParamAngleZ: -5, ParamMouthForm: -0.3 },
  relieved: { ParamEyeLSmile: 0.4, ParamEyeRSmile: 0.4, ParamMouthForm: 0.4, ParamShoulderY: -0.3 },
};

const GAZE: Record<Gaze, Partial2<ParamValues>> = {
  screen: { ParamEyeBallX: -0.5, ParamEyeBallY: -0.2, ParamAngleX: -8 },
  user: { ParamEyeBallX: 0, ParamEyeBallY: 0, ParamAngleX: 0 },
  away: { ParamEyeBallX: 0.7, ParamEyeBallY: 0.3, ParamAngleX: 10 },
};

interface Keyframe {
  t: number;
  v: Partial2<ParamValues>;
}

/** Gesture curves as additive offsets (§12.5 example: tilt_right). */
export const GESTURE_CURVES: Record<Gesture, Keyframe[]> = {
  still: [],
  small_nod: [
    { t: 0, v: { ParamAngleY: 0 } },
    { t: 180, v: { ParamAngleY: -6 } },
    { t: 420, v: { ParamAngleY: 0 } },
  ],
  nod: [
    { t: 0, v: { ParamAngleY: 0 } },
    { t: 200, v: { ParamAngleY: -12 } },
    { t: 450, v: { ParamAngleY: 2 } },
    { t: 650, v: { ParamAngleY: -8 } },
    { t: 950, v: { ParamAngleY: 0 } },
  ],
  small_shake: [
    { t: 0, v: { ParamAngleX: 0 } },
    { t: 150, v: { ParamAngleX: -5 } },
    { t: 320, v: { ParamAngleX: 5 } },
    { t: 500, v: { ParamAngleX: 0 } },
  ],
  shake: [
    { t: 0, v: { ParamAngleX: 0 } },
    { t: 160, v: { ParamAngleX: -12 } },
    { t: 360, v: { ParamAngleX: 12 } },
    { t: 560, v: { ParamAngleX: -8 } },
    { t: 800, v: { ParamAngleX: 0 } },
  ],
  tilt_left: [
    { t: 0, v: { ParamAngleZ: 0 } },
    { t: 220, v: { ParamAngleZ: -7 } },
    { t: 900, v: { ParamAngleZ: -5 } },
    { t: 1500, v: { ParamAngleZ: 0 } },
  ],
  tilt_right: [
    { t: 0, v: { ParamAngleZ: 0 } },
    { t: 220, v: { ParamAngleZ: 7 } },
    { t: 900, v: { ParamAngleZ: 5 } },
    { t: 1500, v: { ParamAngleZ: 0 } },
  ],
  look_screen: [
    { t: 0, v: {} },
    { t: 250, v: { ParamEyeBallX: -0.6, ParamAngleX: -10 } },
    { t: 1600, v: { ParamEyeBallX: -0.6, ParamAngleX: -10 } },
    { t: 2000, v: {} },
  ],
  look_user: [
    { t: 0, v: {} },
    { t: 250, v: { ParamEyeBallX: 0, ParamAngleX: 0, ParamAngleY: 2 } },
    { t: 1200, v: {} },
  ],
  look_away: [
    { t: 0, v: {} },
    { t: 300, v: { ParamEyeBallX: 0.8, ParamAngleX: 12 } },
    { t: 1400, v: { ParamEyeBallX: 0.7, ParamAngleX: 10 } },
    { t: 1900, v: {} },
  ],
  lean_forward: [
    { t: 0, v: {} },
    { t: 300, v: { ParamBodyAngleY: 6, ParamAngleY: 4, ParamBaseY: 0.05 } },
    { t: 1400, v: { ParamBodyAngleY: 5, ParamAngleY: 3, ParamBaseY: 0.04 } },
    { t: 2000, v: {} },
  ],
  recoil: [
    { t: 0, v: {} },
    { t: 120, v: { ParamBodyAngleY: -6, ParamAngleY: 5, ParamShoulderY: 0.5 } },
    { t: 700, v: { ParamBodyAngleY: -3, ParamShoulderY: 0.2 } },
    { t: 1200, v: {} },
  ],
  sigh: [
    { t: 0, v: {} },
    { t: 500, v: { ParamShoulderY: 0.4, ParamBreath: 0.6 } },
    { t: 1200, v: { ParamShoulderY: -0.4, ParamAngleY: -4, ParamBreath: -0.3 } },
    { t: 1900, v: {} },
  ],
  tiny_shrug: [
    { t: 0, v: {} },
    { t: 200, v: { ParamShoulderY: 0.6, ParamAngleZ: 2 } },
    { t: 550, v: { ParamShoulderY: 0.5 } },
    { t: 850, v: {} },
  ],
};

function ease(k: number): number {
  // Cubic in-out; a cheap stand-in for the Bezier curves in §12.5.
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
}

export function sampleGesture(gesture: Gesture, t: number): Partial2<ParamValues> {
  const kfs = GESTURE_CURVES[gesture];
  if (kfs.length === 0) return {};
  const last = kfs[kfs.length - 1]!;
  if (t >= last.t) return {};
  for (let i = 1; i < kfs.length; i++) {
    const b = kfs[i]!;
    if (t <= b.t) {
      const a = kfs[i - 1]!;
      const k = ease((t - a.t) / Math.max(1, b.t - a.t));
      const out: Partial2<ParamValues> = {};
      const keys = new Set([...Object.keys(a.v), ...Object.keys(b.v)]) as Set<ParamName>;
      for (const key of keys) {
        const av = a.v[key] ?? 0;
        const bv = b.v[key] ?? 0;
        out[key] = av + (bv - av) * k;
      }
      return out;
    }
  }
  return {};
}

export function gestureDuration(gesture: Gesture): number {
  const kfs = GESTURE_CURVES[gesture];
  return kfs.length ? kfs[kfs.length - 1]!.t : 0;
}

/** Critically-damped-ish spring for smooth returns to neutral. */
class Spring {
  value = 0;
  velocity = 0;
  constructor(private readonly stiffness = 120, private readonly damping = 2 * Math.sqrt(120)) {}
  step(target: number, dt: number): number {
    const accel = this.stiffness * (target - this.value) - this.damping * this.velocity;
    this.velocity += accel * dt;
    this.value += this.velocity * dt;
    return this.value;
  }
}

export interface DirectorOptions {
  random?: () => number;
  /** Seconds (Hz) of the breath cycle. */
  breathPeriod?: number;
}

/**
 * Holds the current emotional target and ticks parameters every frame.
 * Hair/glasses follow the head with lag via their own springs.
 */
export class AvatarDirector {
  private cue: PerformanceCue = { emotion: 'neutral', intensity: 0, gaze: 'user', gesture: 'still' };
  private cueAt = 0;
  private emotionHoldMs = 4_000;
  private gestureStart = -Infinity;
  private gesture: Gesture = 'still';
  private lipsync: LipSyncKeyframe[] | null = null;
  private lipsyncStart = 0;
  private nextBlinkAt = 0;
  private blinkStart = -Infinity;
  private nextGlanceAt = 0;
  private glance = { x: 0, y: 0 };
  private springs = new Map<ParamName, Spring>();
  private glassesSpring = new Spring(60, 9);
  private lastT: number | null = null;
  private readonly random: () => number;
  private readonly breathPeriod: number;

  constructor(opts: DirectorOptions = {}) {
    this.random = opts.random ?? Math.random;
    this.breathPeriod = opts.breathPeriod ?? 3.6;
    for (const k of PARAMS) this.springs.set(k, new Spring(k.startsWith('ParamEye') ? 300 : 120));
  }

  perform(cue: PerformanceCue, now: number): void {
    this.cue = cue;
    this.cueAt = now;
    // Stronger emotions linger a bit longer before relaxing to neutral.
    this.emotionHoldMs = 2_500 + cue.intensity * 4_000;
    if (cue.gesture !== 'still') {
      this.gesture = cue.gesture;
      this.gestureStart = now;
    }
  }

  startLipSync(frames: LipSyncKeyframe[], now: number): void {
    this.lipsync = frames;
    this.lipsyncStart = now;
  }

  stopLipSync(): void {
    this.lipsync = null;
  }

  /** Advance one frame. `now` in ms. */
  tick(now: number): ParamValues {
    const dt = this.lastT === null ? 1 / 60 : Math.min(0.1, Math.max(0.001, (now - this.lastT) / 1000));
    this.lastT = now;
    const target = zeroParams();

    // Expression, relaxing toward neutral after the hold time.
    const since = now - this.cueAt;
    const relax = since < this.emotionHoldMs ? 1 : Math.max(0, 1 - (since - this.emotionHoldMs) / 1500);
    const weight = this.cue.intensity * relax;
    const expr = EXPRESSIONS[this.cue.emotion];
    for (const [k, v] of Object.entries(expr) as Array<[ParamName, number]>) {
      const base = k === 'ParamEyeLOpen' || k === 'ParamEyeROpen' ? 1 : 0;
      target[k] = base + (v - base) * weight;
    }
    target.ParamEmotionWeight = weight;

    // Gaze, plus small idle glances.
    for (const [k, v] of Object.entries(GAZE[this.cue.gaze]) as Array<[ParamName, number]>) target[k] += v * relax;
    if (now >= this.nextGlanceAt) {
      this.glance = { x: (this.random() - 0.5) * 0.3, y: (this.random() - 0.5) * 0.15 };
      this.nextGlanceAt = now + 2_000 + this.random() * 4_000;
    }
    target.ParamEyeBallX += this.glance.x;
    target.ParamEyeBallY += this.glance.y;

    // Gesture offsets.
    const g = sampleGesture(this.gesture, now - this.gestureStart);
    for (const [k, v] of Object.entries(g) as Array<[ParamName, number]>) target[k] += v;

    // Idle: breath and a very small head sway; never flashy (§12.6).
    const phase = ((now / 1000) * 2 * Math.PI) / this.breathPeriod;
    target.ParamBreath += (Math.sin(phase) + 1) / 2;
    target.ParamAngleX += Math.sin(phase * 0.37) * 1.2;
    target.ParamAngleZ += Math.sin(phase * 0.23 + 1) * 0.8;
    target.ParamBodyAngleX += Math.sin(phase * 0.31) * 0.6;

    const out = {} as ParamValues;
    for (const k of PARAMS) out[k] = this.springs.get(k)!.step(target[k], dt);

    // Blink every 1.8–6 s (applied after springs so it stays crisp).
    if (now >= this.nextBlinkAt) {
      this.blinkStart = now;
      this.nextBlinkAt = now + 1_800 + this.random() * 4_200;
    }
    const b = now - this.blinkStart;
    if (b >= 0 && b < 160) {
      const closed = b < 70 ? b / 70 : 1 - (b - 70) / 90;
      out.ParamEyeLOpen *= 1 - closed;
      out.ParamEyeROpen *= 1 - closed;
    }

    // Lip sync overrides the mouth while speaking.
    if (this.lipsync) {
      const lt = now - this.lipsyncStart;
      const last = this.lipsync[this.lipsync.length - 1];
      if (!last || lt > last.t) {
        this.lipsync = null;
      } else {
        const m = sampleLipSync(this.lipsync, lt);
        out.ParamMouthOpenY = m.open;
        out.ParamMouthForm = out.ParamMouthForm * 0.4 + m.form * 0.6;
      }
    }

    // Glasses lag behind head motion.
    const headMotion = out.ParamAngleY / 30;
    out.ParamGlassesBounce = this.glassesSpring.step(headMotion, dt) - headMotion;
    out.ParamGlassesTilt = out.ParamAngleZ * 0.15;
    return out;
  }
}
