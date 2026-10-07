import type { DesktopTextState } from '../core/desktopText/DesktopText';
import './text-overlay.css';

const textElement = document.querySelector<HTMLDivElement>('#text')!;
const pageElement = document.querySelector<HTMLDivElement>('#page')!;
const canvas = document.createElement('canvas');
const measure = canvas.getContext('2d')!;
let state: DesktopTextState | null = null;

/** Actual font metrics, not character counts: long Latin words and Japanese both wrap. */
function pages(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const c of text.replace(/\r/g, '')) {
    if (c === '\n') { lines.push(line); line = ''; continue; }
    if (line && measure.measureText(line + c).width > width) { lines.push(line); line = ''; }
    line += c;
  }
  lines.push(line);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += maxLines) out.push(lines.slice(i, i + maxLines).join('\n'));
  return out;
}

function render(next: DesktopTextState): void {
  state = next;
  const s = next.settings;
  document.body.style.fontFamily = s.fontFamily;
  document.body.style.fontSize = `${s.fontSize}px`;
  document.body.style.lineHeight = String(s.lineHeight);
  document.body.style.opacity = String(s.opacity);
  document.body.classList.toggle('draggable', !s.clickThrough);
  for (const el of [textElement, pageElement]) {
    el.style.color = s.color;
    el.style.webkitTextStroke = `${s.strokeWidth}px rgba(0,0,0,.82)`;
    el.style.textShadow = s.shadow ? '0 1px 2px rgba(0,0,0,.72), 0 0 4px rgba(0,0,0,.35)' : 'none';
  }
  measure.font = `${s.fontSize}px ${s.fontFamily}`;
  const all = pages(next.text, Math.max(1, window.innerWidth - 32), s.maxLines);
  window.navi.desktopText.layout(next.revision, all.length);
  const page = Math.min(next.page, all.length - 1);
  // Always textContent: research/output text can never execute markup.
  textElement.textContent = next.visible ? all[page]! : '';
  pageElement.textContent = next.visible && all.length > 1 ? `${page + 1} / ${all.length}　次・前で切り替え` : '';
  textElement.dataset.mode = next.mode;
  textElement.dataset.style = next.style;
}

window.navi.desktopText.onState(render);
void window.navi.desktopText.getState().then(render);
window.addEventListener('resize', () => { if (state) render(state); });
let moveTimer: ReturnType<typeof setTimeout> | null = null;
window.addEventListener('mouseup', () => {
  if (moveTimer) clearTimeout(moveTimer);
  moveTimer = setTimeout(() => window.navi.desktopText.moved(), 200);
});
