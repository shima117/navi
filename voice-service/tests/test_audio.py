import unittest
from tempfile import TemporaryDirectory
from pathlib import Path

import numpy as np

from navi_voice.audio.resampler import pcm16_to_mono_16k
from navi_voice.audio.ring_buffer import PcmRingBuffer
from navi_voice.audio.router import AudioRouter
from navi_voice.audio.sources import AudioSource
from navi_voice.audio.events import AudioEventClassifier, classify_recent
from navi_voice.voicemeeter import VoicemeeterController


class AudioPipelineTest(unittest.TestCase):
    def test_resamples_48k_stereo_to_16k_mono(self):
        left = np.full(4_800, 10_000, dtype=np.int16)
        right = np.zeros(4_800, dtype=np.int16)
        stereo = np.column_stack((left, right)).reshape(-1).tobytes()
        converted = np.frombuffer(pcm16_to_mono_16k(stereo, 48_000, 2), dtype=np.int16)
        self.assertEqual(converted.size, 1_600)
        self.assertAlmostEqual(float(converted.mean()), 5_000, delta=3)

    def test_ring_is_bounded_and_ram_only(self):
        ring = PcmRingBuffer(0.1, 16_000)
        ring.append(np.arange(3_200, dtype=np.int16).tobytes())
        self.assertEqual(len(ring.recent(1)), 3_200)
        self.assertAlmostEqual(ring.duration, 0.1, places=3)

    def test_router_keeps_sources_separate(self):
        router = AudioRouter()
        mic = np.full(1_600, 1_000, dtype=np.int16).tobytes()
        remote = np.full(1_600, 2_000, dtype=np.int16).tobytes()
        router.route(AudioSource.USER_MIC, mic, 16_000)
        router.route(AudioSource.REMOTE, remote, 16_000)
        self.assertEqual(router.recent(AudioSource.USER_MIC, 0.1), mic)
        self.assertEqual(router.recent(AudioSource.REMOTE, 0.1), remote)
        self.assertEqual(router.recent(AudioSource.SYSTEM, 0.1), b"")

    def test_rejects_invalid_format(self):
        with self.assertRaises(ValueError):
            pcm16_to_mono_16k(b"\x00\x00", 0)
        with self.assertRaises(ValueError):
            AudioSource.parse("not-a-source", AudioSource.USER_MIC)

    def test_system_transient_is_conservative_and_throttled(self):
        classifier = AudioEventClassifier()
        quiet = np.zeros(1_600, dtype=np.int16).tobytes()
        impact = np.full(1_600, 20_000, dtype=np.int16).tobytes()
        self.assertIsNone(classifier.process(quiet, 100))
        detected = classifier.process(impact, 200)
        self.assertEqual(detected.type, "transient_candidate")
        self.assertLess(detected.confidence, 0.7)
        self.assertIsNone(classifier.process(impact, 300))
        self.assertEqual(classify_recent(quiet + impact, 1_000).type, "transient_candidate")


class VoicemeeterSafetyTest(unittest.TestCase):
    def test_difference_restore_and_never_gain(self):
        with TemporaryDirectory() as temp:
            controller = VoicemeeterController(state_dir=Path(temp))
            values = {}
            for index in (5, 6, 7):
                for route in ("A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3"):
                    values[f"Strip[{index}].{route}"] = 1.0 if index == 7 and route.startswith("B") else 0.0
            controller.vm_type = lambda: "potato"
            controller._get = lambda parameter: values[parameter]
            controller._set = lambda parameter, value: values.__setitem__(parameter, value)

            snapshot = controller.auto_configure()
            self.assertEqual(len(snapshot.changed), 3)
            self.assertFalse(any("Gain" in change.parameter for change in snapshot.changed))
            # A second apply and an explicit backup must not lose the first restore values.
            self.assertEqual(len(controller.auto_configure().changed), 3)
            controller.snapshot(save=True)
            self.assertTrue(controller.manual_snapshot_file.exists())
            # User changed B1 after NAVI configured it: difference-aware restore must leave it alone.
            values["Strip[7].B1"] = 1.0
            controller.auto_configure()
            self.assertEqual(values["Strip[7].B1"], 1.0)
            restored = controller.restore()
            self.assertEqual(restored, {"restored": 2, "skipped": 1})
            self.assertEqual(values["Strip[7].B1"], 1.0)
            self.assertEqual(values["Strip[7].B2"], 1.0)
            self.assertEqual(values["Strip[7].B3"], 1.0)

    def test_crash_between_route_writes_keeps_restore_journal(self):
        with TemporaryDirectory() as temp:
            controller = VoicemeeterController(state_dir=Path(temp))
            values = {
                f"Strip[{index}].{route}": 1.0 if index == 7 and route.startswith("B") else 0.0
                for index in (5, 6, 7)
                for route in ("A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3")
            }
            controller.vm_type = lambda: "potato"
            controller._get = lambda parameter: values[parameter]

            def interrupted_set(parameter, value):
                if parameter == "Strip[7].B2":
                    raise RuntimeError("native process interrupted")
                values[parameter] = value

            controller._set = interrupted_set
            with self.assertRaises(RuntimeError):
                controller.auto_configure()
            self.assertTrue(controller.crash_recovery()["pending"])
            self.assertEqual(values["Strip[7].B1"], 0.0)
            controller._set = lambda parameter, value: values.__setitem__(parameter, value)
            self.assertEqual(controller.restore(), {"restored": 1, "skipped": 1})
            self.assertEqual(values["Strip[7].B1"], 1.0)

    def test_gain_write_is_rejected_before_native_call(self):
        controller = VoicemeeterController()
        with self.assertRaises(ValueError):
            controller._set("Strip[7].Gain", -10.0)


if __name__ == "__main__":
    unittest.main()
