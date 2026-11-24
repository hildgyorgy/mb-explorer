import io
import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent / "upnp-bridge"))
import musicards_upnp_bridge as bridge


class DiscoveryTests(unittest.TestCase):
    def test_private_renderer_addresses(self):
        for value in ("192.168.0.185", "10.2.3.4", "172.16.2.3"):
            self.assertIsNotNone(bridge.private_lan_address(value))
        for value in ("127.0.0.1", "8.8.8.8", "not-an-ip"):
            self.assertIsNone(bridge.private_lan_address(value))

    @patch.object(bridge.subprocess, "run")
    def test_deep_search_stays_on_local_subnet(self, run):
        run.return_value = SimpleNamespace(
            stdout="en1: flags=...\n\tinet 192.168.0.184 netmask 0xffffff00 broadcast 192.168.0.255\n")
        hosts = bridge.mac_subnet_candidates("en1")
        self.assertEqual(len(hosts), 253)
        self.assertIn("192.168.0.185", hosts)
        self.assertNotIn("192.168.0.184", hosts)
        self.assertNotIn("192.168.1.1", hosts)

    @patch.object(bridge.subprocess, "run")
    def test_wide_subnet_is_capped_to_24(self, run):
        run.return_value = SimpleNamespace(
            stdout="inet 10.2.3.4 netmask 0xfffff000 broadcast 10.2.15.255\n")
        hosts = bridge.mac_subnet_candidates("en1")
        self.assertEqual(len(hosts), 253)
        self.assertIn("10.2.3.5", hosts)
        self.assertNotIn("10.2.4.1", hosts)

    def test_discovery_does_not_block_audio_proxy(self):
        state = bridge.BridgeState()
        state.proxy_sources["stream"] = ("http://example.test/audio", time.monotonic())
        scanning = threading.Event()
        release_scan = threading.Event()
        result = []

        def slow_discovery():
            scanning.set()
            release_scan.wait(2)
            return []

        with patch.object(bridge, "discover", side_effect=slow_discovery):
            scan_thread = threading.Thread(target=state.refresh)
            scan_thread.start()
            self.assertTrue(scanning.wait(1))
            proxy_thread = threading.Thread(
                target=lambda: result.append(state.proxy_source("stream")))
            proxy_thread.start()
            proxy_thread.join(0.2)
            proxy_was_blocked = proxy_thread.is_alive()
            release_scan.set()
            scan_thread.join(2)
            proxy_thread.join(2)
        self.assertFalse(proxy_was_blocked)
        self.assertEqual(result, ["http://example.test/audio"])

    def test_control_rejects_unexpected_host(self):
        handler = bridge.Handler.__new__(bridge.Handler)
        handler.client_address = ("127.0.0.1", 12345)
        handler.headers = {"Host": "evil.example:9181"}
        self.assertFalse(handler.allow_control_request())
        handler.headers = {"Host": "127.0.0.1:9181"}
        self.assertTrue(handler.allow_control_request())
        handler.headers = {
            "Host": "mac.tail123.ts.net",
            "Origin": "https://hildgyorgy.github.io",
        }
        self.assertTrue(handler.allow_control_request())

    def test_seek_clock_carries_minutes_into_hours(self):
        self.assertEqual(bridge.upnp_clock(4500), "1:15:00")
        self.assertEqual(bridge.upnp_clock(-10), "0:00:00")

    def test_renderer_volume_service_and_device_range(self):
        description = b'''<root><device><UDN>uuid:speaker</UDN><serviceList>
          <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
            <controlURL>/transport</controlURL></service>
          <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:2</serviceType>
            <controlURL>/rendering</controlURL><SCPDURL>/rendering.xml</SCPDURL></service>
        </serviceList></device></root>'''
        scpd = b'''<scpd><serviceStateTable><stateVariable><name>Volume</name>
          <allowedValueRange><minimum>0</minimum><maximum>80</maximum></allowedValueRange>
        </stateVariable></serviceStateTable></scpd>'''
        with patch.object(bridge.urllib.request, "urlopen", return_value=io.BytesIO(description)):
            renderer = bridge.renderer_from_description("http://192.168.0.185/device.xml")
        self.assertEqual(renderer["renderingControlUrl"], "http://192.168.0.185/rendering")
        self.assertEqual(renderer["renderingControlScpdUrl"], "http://192.168.0.185/rendering.xml")
        with patch.object(bridge.urllib.request, "urlopen", return_value=io.BytesIO(scpd)):
            self.assertEqual(bridge.volume_range(renderer), (0, 80))

    def test_volume_uses_rendering_control_and_rejects_out_of_range_values(self):
        renderer = {"id": "uuid:speaker", "serviceType": "urn:schemas-upnp-org:service:AVTransport:1",
                    "controlUrl": "http://192.168.0.185/transport",
                    "renderingControlServiceType": "urn:schemas-upnp-org:service:RenderingControl:2",
                    "renderingControlUrl": "http://192.168.0.185/rendering"}
        handler = bridge.Handler.__new__(bridge.Handler)
        handler.client_address = ("127.0.0.1", 12345)
        handler.headers = {"Host": "127.0.0.1:9181"}
        handler.path = "/renderers/uuid%3Aspeaker/volume"
        replies = []
        handler.send_json = lambda status, payload: replies.append((status, payload))
        handler.read_json = lambda: {"volume": 32}
        with patch.object(bridge.STATE, "get", return_value=renderer), \
             patch.object(bridge.STATE, "volume_range", return_value=(0, 80)), \
             patch.object(bridge, "soap_text", return_value={"CurrentVolume": "30"}) as read, \
             patch.object(bridge, "soap_call") as write:
            handler.do_GET()
            self.assertEqual(replies[-1], (200, {"volume": 30, "min": 0, "max": 80}))
            self.assertEqual(read.call_args.args[0]["serviceType"], renderer["renderingControlServiceType"])
            handler.do_POST()
            self.assertEqual(replies[-1], (200, {"volume": 32, "min": 0, "max": 80}))
            self.assertEqual(write.call_args.args[1], "SetVolume")
            self.assertIn(("DesiredVolume", 32), write.call_args.args[2])
            handler.read_json = lambda: {"volume": 81}
            handler.do_POST()
            self.assertEqual(replies[-1][0], 400)
            self.assertEqual(write.call_count, 1)


if __name__ == "__main__":
    unittest.main()
