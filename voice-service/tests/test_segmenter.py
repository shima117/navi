import unittest

from navi_voice.segmenter import FRAME_BYTES, FrameAssembler, Segmenter

F = b"\x00" * FRAME_BYTES


def run(seg, pattern):
    events = []
    for voiced in pattern:
        events.extend(seg.push(F, voiced))
    return events


class SegmenterTest(unittest.TestCase):
    def test_utterance_start_and_end(self):
        seg = Segmenter()
        events = run(seg, [False] * 5 + [True] * 20 + [False] * 20)
        self.assertEqual([e.kind for e in events], ["speech_started", "speech_ended"])
        audio = events[1].audio
        self.assertIsNotNone(audio)
        # preroll (5 silent + 3 voiced) + remaining voiced (17) + trailing silence (20)
        self.assertEqual(len(audio) // FRAME_BYTES, 8 + 17 + 20)

    def test_short_blip_is_not_transcribed(self):
        seg = Segmenter()
        events = run(seg, [True] * 4 + [False] * 20)
        self.assertEqual([e.kind for e in events], ["speech_started", "speech_ended"])
        self.assertIsNone(events[1].audio)

    def test_noise_does_not_start_speech(self):
        seg = Segmenter()
        self.assertEqual(run(seg, [True, False, True, False, True, True, False] * 10), [])

    def test_assembler_rechunks(self):
        a = FrameAssembler()
        self.assertEqual(a.feed(b"\x00" * 1000), [F, F][:1000 // FRAME_BYTES])
        self.assertEqual(len(a.feed(b"\x00" * 1000)), (2000 // FRAME_BYTES) - (1000 // FRAME_BYTES))


if __name__ == "__main__":
    unittest.main()
