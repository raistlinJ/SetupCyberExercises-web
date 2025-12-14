import json
import os
import tempfile
import unittest

from app.storage.projects import ProjectStore


class NotifyTemplateStartupMigrationTests(unittest.TestCase):

    def test_startup_migration_rewrites_stringified_dict_templates(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, 'projects.json')
            with open(db_path, 'w', encoding='utf-8') as f:
                json.dump({
                    'p1': {
                        'id': 'p1',
                        'name': 'P1',
                        'audio': {
                            'event:challenge_solved': {
                                'enabled': True,
                                'soundKey': 'media:none',
                                'speak': True,
                                'speakTemplates': ["{'text': 'hello {{audio}}', 'enabled': True, 'soundKey': 'media:abc'}"],
                                'speakTemplate': {'template': 'legacy single'},
                            }
                        }
                    }
                }, f, indent=2, sort_keys=True)

            # Instantiation triggers the one-time migration.
            ProjectStore(tmp)

            with open(db_path, 'r', encoding='utf-8') as f:
                data = json.load(f)

            evt = (data.get('p1') or {}).get('audio', {}).get('event:challenge_solved') or {}
            self.assertEqual(evt.get('speakTemplates'), ['hello {{audio}}', 'legacy single'])
            self.assertNotIn('speakTemplate', evt)

            # Flag file should exist to prevent repeated scans.
            self.assertTrue(os.path.exists(os.path.join(tmp, '.notify_templates_migrated_v1')))
