import unittest

from app.routes.api import _bridge_ageing_update_script_lines


class BridgeAgeingScriptTests(unittest.TestCase):
    def test_updates_only_existing_stanzas_and_repairs_legacy_partial_bridge(self):
        script = '\n'.join(_bridge_ageing_update_script_lines(
            ['default', 'lab1'],
            'TEST-AGEING',
        ))

        self.assertIn('stanza absent', script)
        self.assertIn('return 0', script)
        self.assertIn('bridge-ports none', script)
        self.assertIn('bridge-ageing 0', script)
        self.assertNotIn('echo "iface ', script)
        self.assertIn(
            'for IFACE in default lab1; do repair_bridge_ageing "$MAIN" "$IFACE"; '
            'repair_bridge_ageing "$NEW" "$IFACE"; done',
            script,
        )

    def test_rejects_unsafe_interface_names(self):
        with self.assertRaises(ValueError):
            _bridge_ageing_update_script_lines(['good1', 'bad;touch-file'])


if __name__ == '__main__':
    unittest.main()
