import unittest

from app import create_app
from app.routes import api


class JobStatusApiTests(unittest.TestCase):

    def setUp(self):
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()
        self.pid = 'proj-status'
        self.job_key = api._job_key(self.pid)

    def tearDown(self):
        with api._JOB_LOCK:
            api._ACTIVE_JOBS.pop(self.job_key, None)

    def _seed_job(self, **overrides):
        record = {
            'project': self.pid,
            'name': 'run_startup_cmds',
            'action': 'run_startup_cmds',
            'status': 'running',
            'progress': 42,
            'phase': 'command',
            'current': 'alpha',
            'message': 'Running command',
            'detail': overrides.get('detail', {}),
            'cancel': False,
        }
        record.update(overrides)
        with api._JOB_LOCK:
            api._ACTIVE_JOBS[self.job_key] = record

    def test_status_endpoint_returns_command_detail(self):
        detail = {
            'kind': 'command',
            'vm': 'alpha',
            'command_number': 2,
            'command_total': 5,
            'step': 1,
            'command_index': 2,
        }
        self._seed_job(detail=detail)

        resp = self.client.get(f'/api/projects/{self.pid}/instances/actions/status')
        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json()
        self.assertEqual(payload.get('detail'), detail)
        self.assertEqual(payload.get('phase'), 'command')
        self.assertEqual(payload.get('progress'), 42)

    def test_status_endpoint_returns_404_when_no_job(self):
        resp = self.client.get(f'/api/projects/{self.pid}/instances/actions/status')
        self.assertEqual(resp.status_code, 404)
        payload = resp.get_json()
        self.assertIn('error', payload)


if __name__ == '__main__':
    unittest.main()
