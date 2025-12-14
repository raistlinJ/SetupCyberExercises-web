import unittest
from unittest.mock import patch

from app.routes import api


class CommandStatusTests(unittest.TestCase):

    def setUp(self):
        self.entry = {'name': 'alpha', 'index': 1}

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
