import { AvatarDirector, type ParamValues } from '../avatar/AvatarDirector';
import type { PerformanceCue } from '../core/types';

/**
 * Avatar window entry. Drives AvatarDirector at display refresh rate and
 * draws a procedural placeholder face. The PuppetJS PSD renderer replaces
 * `drawPlaceholder` in PR-07; the parameter contract stays the same.
 */
const canvas = document.getElementById('avatar') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const director = new AvatarDirector();

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

window.navi.avatar.onPerformance((cue) => director.perform(cue as PerformanceCue, performance.now()));
window.navi.avatar.onLipSync((frames) => {
  if (frames) director.startLipSync(frames, performance.now());
  else director.stopLipSync();
});

function drawPlaceholder(p: ParamValues): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2 + p.ParamAngleX * 1.5 + p.ParamBodyAngleX * 2;
  const cy = h * 0.42 - p.ParamAngleY * 1.2 - p.ParamBreath * 2 - p.ParamShoulderY * 6;
  const r = Math.min(w, h) * 0.28;

  // Body
  ctx.fillStyle = '#2b2f3c';
  ctx.beginPath();
  ctx.ellipse(w / 2, h * 0.95 - p.ParamShoulderY * 6, r * 1.3, r * 0.9 + p.ParamBreath * 3, 0, Math.PI, 0);
  ctx.fill();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((p.ParamAngleZ * Math.PI) / 180);

  // Hair back + face
  ctx.fillStyle = '#3a2a2a';
  ctx.beginPath();
  ctx.ellipse(0, -r * 0.05, r * 1.08, r * 1.12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f6e1d3';
  ctx.beginPath();
  ctx.ellipse(0, r * 0.08, r * 0.86, r * 0.95, 0, 0, Math.PI * 2);
  ctx.fill();

  // Cheeks
  if (p.ParamCheek > 0.02) {
    ctx.fillStyle = `rgba(240, 120, 130, ${Math.min(0.6, p.ParamCheek * 0.6)})`;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * r * 0.48, r * 0.35, r * 0.16, r * 0.08, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Eyes
  const eyeY = r * 0.05;
  for (const [s, open, smile, brow] of [
    [-1, p.ParamEyeLOpen, p.ParamEyeLSmile, p.ParamBrowLY],
    [1, p.ParamEyeROpen, p.ParamEyeRSmile, p.ParamBrowRY],
  ] as const) {
    const ex = s * r * 0.36 + p.ParamAngleX * 0.4;
    const eh = r * 0.17 * Math.max(0.04, Math.min(1.3, open) * (1 - smile * 0.6));
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(ex, eyeY, r * 0.15, eh, 0, 0, Math.PI * 2);
    ctx.fill();
    if (eh > r * 0.03) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(ex, eyeY, r * 0.15, eh, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#4a3550';
      ctx.beginPath();
      ctx.arc(ex + p.ParamEyeBallX * r * 0.07, eyeY + p.ParamEyeBallY * r * 0.06, r * 0.09, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // Brow
    ctx.strokeStyle = '#3a2a2a';
    ctx.lineWidth = r * 0.035;
    ctx.beginPath();
    const by = eyeY - r * 0.27 - brow * r * 0.08;
    ctx.moveTo(ex - r * 0.13, by + s * brow * r * 0.03);
    ctx.lineTo(ex + r * 0.13, by - s * brow * r * 0.03);
    ctx.stroke();
  }

  // Mouth: open → height, form → width/curve
  const mw = r * (0.16 + Math.max(0, p.ParamMouthForm) * 0.08 - Math.max(0, -p.ParamMouthForm) * 0.06);
  const mh = r * 0.02 + Math.max(0, p.ParamMouthOpenY) * r * 0.17;
  ctx.fillStyle = '#9b3d4a';
  ctx.beginPath();
  ctx.ellipse(p.ParamAngleX * 0.3, r * 0.52 - p.ParamMouthForm * r * 0.02, mw, mh, 0, 0, Math.PI * 2);
  ctx.fill();

  // Red glasses, lagging slightly behind the head
  ctx.save();
  ctx.translate(0, p.ParamGlassesBounce * r * 0.4);
  ctx.rotate((p.ParamGlassesTilt * Math.PI) / 180);
  ctx.strokeStyle = '#d42a2a';
  ctx.lineWidth = r * 0.04;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.roundRect(s * r * 0.36 - r * 0.22, eyeY - r * 0.16, r * 0.44, r * 0.3, r * 0.08);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(-r * 0.14, eyeY - r * 0.04);
  ctx.lineTo(r * 0.14, eyeY - r * 0.04);
  ctx.stroke();
  ctx.restore();

  // Front hair
  ctx.fillStyle = '#3a2a2a';
  ctx.beginPath();
  ctx.ellipse(0, -r * 0.62, r * 0.9, r * 0.38, 0, Math.PI, 0);
  ctx.fill();

  ctx.restore();
}

function frame(now: number): void {
  try {
    drawPlaceholder(director.tick(now));
  } catch (err) {
    console.error('[avatar] frame failed', err);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
