import { describe, expect, it } from 'vitest';
import { AvatarDirector, gestureDuration, sampleGesture } from '../src/avatar/AvatarDirector';

function run(d: AvatarDirector, from: number, to: number) {
  let p = d.tick(from);
  for (let t = from + 16; t <= to; t += 16) p = d.tick(t);
  return p;
}

describe('AvatarDirector', () => {
  it('tilt_right follows the §12.5 curve and returns to 0', () => {
    expect(sampleGesture('tilt_right', 220).ParamAngleZ).toBeCloseTo(7);
    expect(sampleGesture('tilt_right', 900).ParamAngleZ).toBeCloseTo(5);
    expect(sampleGesture('tilt_right', gestureDuration('tilt_right'))).toEqual({});
  });

  it('unimpressed narrows the eyes (half-closed)', () => {
    const d = new AvatarDirector({ random: () => 0.99 });
    d.tick(0);
    d.perform({ emotion: 'unimpressed', intensity: 1, gaze: 'user', gesture: 'still' }, 0);
    // Sample between blinks.
    const p = run(d, 16, 1_000);
    expect(p.ParamEyeLOpen).toBeLessThan(0.6);
  });

  it('embarrassed raises the cheek and lowers the gaze', () => {
    const d = new AvatarDirector({ random: () => 0.5 });
    d.perform({ emotion: 'embarrassed', intensity: 1, gaze: 'user', gesture: 'still' }, 0);
    const p = run(d, 0, 1_000);
    expect(p.ParamCheek).toBeGreaterThan(0.8);
    expect(p.ParamEyeBallY).toBeLessThan(-0.2);
  });

  it('relaxes back to neutral after the hold time', () => {
    const d = new AvatarDirector({ random: () => 0.5 });
    d.perform({ emotion: 'embarrassed', intensity: 1, gaze: 'user', gesture: 'tilt_right' }, 0);
    const p = run(d, 0, 12_000);
    expect(p.ParamCheek).toBeLessThan(0.05);
    expect(Math.abs(p.ParamAngleZ)).toBeLessThan(2);
  });

  it('lip sync drives the mouth and stops at the end', () => {
    const d = new AvatarDirector({ random: () => 0.5 });
    d.startLipSync(
      [
        { t: 0, open: 0, form: 0 },
        { t: 100, open: 1, form: 0 },
        { t: 200, open: 0, form: 0 },
      ],
      0,
    );
    d.tick(0);
    expect(d.tick(100).ParamMouthOpenY).toBeCloseTo(1);
    const after = run(d, 116, 1_500);
    expect(after.ParamMouthOpenY).toBeLessThan(0.05);
  });

  it('glasses lag behind a nod', () => {
    const d = new AvatarDirector({ random: () => 0.5 });
    d.perform({ emotion: 'neutral', intensity: 0, gaze: 'user', gesture: 'nod' }, 0);
    let maxBounce = 0;
    for (let t = 0; t < 1_200; t += 16) maxBounce = Math.max(maxBounce, Math.abs(d.tick(t).ParamGlassesBounce));
    expect(maxBounce).toBeGreaterThan(0.01);
  });
});
