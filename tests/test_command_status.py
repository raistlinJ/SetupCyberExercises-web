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
            self.assertEqual([u['message'].split(' · ')[0] for u in updates], [
                '3/3 machines remaining', '3/3 machines remaining',
                '2/3 machines remaining', '2/3 machines remaining', '0/3 machines remaining',
            ])

    def test_startup_count_tracks_finished_machines(self):
        updates = []
        record = {'name': 'run_startup_cmds', 'queue_progress': updates.append}
        with patch.dict(api._ACTIVE_JOBS, {'project:remaining-test': record}):
            for entry in api._job_items('remaining-test', [self.entry] * 2, 'commands', 'Running'):
                api._job_emit_command_status('remaining-test', entry, 1, 1, 'hostname')
        self.assertTrue(updates[0]['message'].startswith('2/2 machines remaining'))
        self.assertTrue(updates[-1]['message'].startswith('0/2 machines remaining'))
        commands = [u for u in updates if u.get('phase') == 'command']
        self.assertTrue(commands[0]['message'].startswith('2/2 machines remaining'))
        self.assertTrue(commands[1]['message'].startswith('1/2 machines remaining'))

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
