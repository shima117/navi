import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events/EventBus';

describe('EventBus', () => {
  it('a throwing handler does not stop other handlers', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.on('session.started', () => {
      throw new Error('avatar crashed');
    });
    bus.on('session.started', (e) => seen.push(e.at));
    bus.emit('session.started', { at: 5 });
    expect(seen).toEqual([5]);
  });

  it('unsubscribes', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const off = bus.on('session.ended', (e) => seen.push(e.at));
    off();
    bus.emit('session.ended', { at: 1 });
    expect(seen).toEqual([]);
  });
});
