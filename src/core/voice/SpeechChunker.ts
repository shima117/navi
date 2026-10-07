export interface SpeechChunk {
  id: string;
  text: string;
  interruptible: boolean;
}

/** Split on natural Japanese phrase boundaries without creating tiny orphan chunks. */
export function chunkSpeech(text: string, maxChars = 54): SpeechChunk[] {
  const clean = text.trim();
  if (!clean) return [];
  const sentences = clean.match(/[^。！？!?]+[。！？!?]?/g) ?? [clean];
  const out: string[] = [];
  for (const raw of sentences) {
    let rest = raw.trim();
    while (rest.length > maxChars) {
      const window = rest.slice(0, maxChars + 1);
      const boundary = Math.max(window.lastIndexOf('、'), window.lastIndexOf('，'), window.lastIndexOf(' '));
      const cut = boundary >= Math.floor(maxChars * 0.45) ? boundary + 1 : maxChars;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) {
      const previous = out[out.length - 1];
      if (previous && rest.length < 5 && previous.length + rest.length <= maxChars + 8) out[out.length - 1] = previous + rest;
      else out.push(rest);
    }
  }
  return out.map((part, index) => ({ id: `speech-${index}`, text: part, interruptible: true }));
}

