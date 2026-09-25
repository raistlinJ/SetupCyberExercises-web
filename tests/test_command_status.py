import unittest
from unittest.mock import patch

from app.routes import api


class CommandStatusTests(unittest.TestCase):

    def setUp(self):
        self.entry = {'name': 'alpha', 'index': 1}

    def test_remaining_count_survives_command_validation_and_delay_updates(self):
        for phase in ('commands', 'validation'):
            updates = []
            record = {'name': 'run_stored_cmds', 'queue_progress': updates.append}
            with patch.dict(api._ACTIVE_JOBS, {'project:remaining-test': record}):
                api._job_emit_batch_progress('remaining-test', phase, 'Running', 0, 3)
                api._job_emit_command_status('remaining-test', self.entry, 1, 1, 'hostname')
                api._job_emit_batch_progress('remaining-test', phase, 'Running', 1, 3)
                api._job_emit_delay_status('remaining-test', self.entry, 2, 5)
                api._job_emit_batch_progress('remaining-test', phase, 'Running', 3, 3)
            self.assertEqual([u['item_total'] - u['item_completed'] for u in updates],
                             [3, 3, 2, 2, 0])
            self.assertTrue(all(u['item_total'] == 3 for u in updates))

    def test_startup_count_tracks_finished_machines(self):
        updates = []
        record = {'name': 'run_startup_cmds', 'queue_progress': updates.append}
        with patch.dict(api._ACTIVE_JOBS, {'project:remaining-test': record}):
            for entry in api._job_items('remaining-test', [self.entry] * 2, 'commands', 'Running'):
                api._job_emit_command_status('remaining-test', entry, 1, 1, 'hostname')
        self.assertEqual((updates[0]['item_completed'], updates[0]['item_total']), (0, 2))
        self.assertEqual((updates[-1]['item_completed'], updates[-1]['item_total']), (2, 2))
        commands = [u for u in updates if u.get('phase') == 'command']
        self.assertEqual(commands[0]['item_completed'], 0)
        self.assertEqual(commands[1]['item_completed'], 1)

    def test_sequence_metadata_in_detail(self):
        with patch.object(api, '_update_job_detail') as mock_update:
            api._job_emit_command_status(
                'proj-123',
                entry=self.entry,
                step=2,
                command_idx=1,
                command_text='echo hello',
                command_number=2,
                command_total=5,
                step_command_total=3,
            )

        self.assertTrue(mock_update.called, 'expected _update_job_detail to be invoked')
        _, kwargs = mock_update.call_args
        detail = kwargs.get('detail') or {}
        self.assertEqual(detail.get('command_number'), 2)
        self.assertEqual(detail.get('command_total'), 5)
        self.assertEqual(detail.get('step_command_total'), 3)
        self.assertEqual(detail.get('command_index'), 1)

    def test_message_includes_command_numbering(self):
        with patch.object(api, '_update_job_detail') as mock_update:
            api._job_emit_command_status(
                'proj-123',
                entry=self.entry,
                step=1,
                command_idx=2,
                command_text='sudo reboot',
                command_number=1,
                command_total=4,
            )

        _, kwargs = mock_update.call_args
        message = kwargs.get('message') or ''
        self.assertIn('command 1/4', message)
        self.assertIn('sudo reboot', message)
        self.assertIn('step 1 #2', message)


if __name__ == '__main__':
    unittest.main()
