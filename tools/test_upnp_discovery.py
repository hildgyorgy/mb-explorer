import sys
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


if __name__ == "__main__":
    unittest.main()
