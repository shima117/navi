import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { BargeInController } from '../../src/core/voice/BargeIn';
import { buildLipSyncTimeline } from '../../src/core/voice/LipSync';
import { VoicevoxClient, voiceStyleFor } from '../../src/core/voice/VoicevoxClient';
import { IPC, type VoiceServiceEvent } from '../ipc';
import type { AppContext } from '../context';
import type { Feature } from './Feature';

/** Mic events from the voice service, TTS synthesis, and barge-in (§11). */
export const voiceFeature: Feature = {
  name: 'voice',
  setup(ctx) {
    const { bus, windows, orchestrator, settings } = ctx;

    const bargeIn = new BargeInController({
      fadeOut: () => windows.push({ type: 'stopSpeech' }),
      stopMouth: () => windows.sendAvatar(IPC.avatarLipSync, null),
      markInterrupted: () => bus.emit('voice.interrupted', { at: Date.now() }),
    });

    settings.onChange((next, prev) => {
      if (next.speakerId !== prev.speakerId) ctx.voice.tts = new VoicevoxClient(next.speakerId);
    });

    bus.on('friend.speak', ({ text, cue }) => {
      windows.push({ type: 'transcript', role: 'navi', text, at: Date.now() });
      void speak(ctx, bargeIn, text, cue.emotion, cue.intensity);
    });

    ipcMain.handle(IPC.voiceStart, () => undefined);
    ipcMain.handle(IPC.voiceStop, () => undefined);
    ipcMain.handle(IPC.voiceSetDevice, async (_e, deviceId: string | null) => {
      await settings.patch({ micDeviceId: deviceId });
    });

    ipcMain.on(IPC.voiceEvent, (_e, ev: VoiceServiceEvent) => {
      if (ev.type === 'speech_started') {
        bargeIn.userSpeechStarted();
        bus.emit('voice.speech_started', { at: ev.at });
      } else if (ev.type === 'speech_ended') {
        bargeIn.userSpeechEnded();
      } else if (ev.type === 'transcript' && ev.text.trim()) {
        bargeIn.userSpeechEnded();
        bus.emit('voice.transcript', { id: randomUUID(), text: ev.text.trim(), source: 'voice', at: ev.at });
      }
    });

    ipcMain.on(IPC.voicePlayback, (_e, state: 'started' | 'finished') => {
      if (state === 'started') {
        bargeIn.naviStarted();
        orchestrator.conversation.setSpeaking(true);
      } else {
        bargeIn.naviFinished();
        orchestrator.conversation.setSpeaking(false);
      }
    });
  },
};

async function speak(ctx: AppContext, bargeIn: BargeInController, text: string, emotion: string, intensity: number): Promise<void> {
  const { windows, health, orchestrator } = ctx;
  if (!bargeIn.canSpeak()) return;
  if (!health.isHealthy('tts')) {
    // Subtitles only; no mouth movement without audio (§19).
    windows.push({ type: 'speech', text, audio: null, lipsync: [] });
    return;
  }
  try {
    const temperature = orchestrator.conversation.suggestTemperature(text);
    const { audio, query } = await ctx.voice.tts.synthesize(text, voiceStyleFor(emotion, intensity, temperature));
    if (!bargeIn.canSpeak()) return;
    const lipsync = query ? buildLipSyncTimeline(query) : [];
    windows.push({ type: 'speech', text, audio, lipsync });
  } catch (err) {
    console.error('[tts] failed', err);
    health.reportFailure('tts');
    windows.push({ type: 'speech', text, audio: null, lipsync: [] });
  }
}
