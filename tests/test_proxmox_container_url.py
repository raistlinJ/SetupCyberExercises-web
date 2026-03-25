import os
import unittest
from unittest.mock import patch

from app.connectors.proxmox import (
    ProxmoxClient,
    _fallback_request_url,
    _looks_like_name_resolution_error,
    _normalize_container_localhost_url,
)


class ProxmoxContainerUrlTests(unittest.TestCase):

    def test_normalize_localhost_to_docker_host_alias(self):
        with patch('app.connectors.proxmox._running_in_container', return_value=True):
            with patch.dict(os.environ, {'DOCKER_HOST_ALIAS': 'host.docker.internal'}, clear=False):
                normalized = _normalize_container_localhost_url('https://localhost:8006')
        self.assertEqual(normalized, 'https://host.docker.internal:8006')

    def test_normalize_loopback_ip_to_docker_host_alias(self):
        with patch('app.connectors.proxmox._running_in_container', return_value=True):
            with patch.dict(os.environ, {'DOCKER_HOST_ALIAS': 'host.docker.internal'}, clear=False):
                normalized = _normalize_container_localhost_url('https://127.0.0.1:8006')
        self.assertEqual(normalized, 'https://host.docker.internal:8006')

    def test_leave_remote_host_unchanged(self):
        with patch('app.connectors.proxmox._running_in_container', return_value=True):
            normalized = _normalize_container_localhost_url('https://pve.example.test:8006')
        self.assertEqual(normalized, 'https://pve.example.test:8006')

    def test_client_applies_normalization_in_container(self):
        with patch('app.connectors.proxmox._running_in_container', return_value=True):
            with patch.dict(os.environ, {'DOCKER_HOST_ALIAS': 'host.docker.internal'}, clear=False):
                client = ProxmoxClient(base_url='https://localhost:8006', token='abc', verify=False)
        self.assertEqual(client.base_url, 'https://host.docker.internal:8006')

    def test_dns_failure_fallback_rewrites_request_url(self):
        with patch('app.connectors.proxmox._running_in_container', return_value=True):
            with patch.dict(os.environ, {'DOCKER_HOST_ALIAS': 'host.docker.internal'}, clear=False):
                fallback = _fallback_request_url('https://arlsouth1.utep.edu:8006/api2/json/access/ticket')
        self.assertEqual(fallback, 'https://host.docker.internal:8006/api2/json/access/ticket')

    def test_name_resolution_error_detection(self):
        err = RuntimeError('Failed to resolve host during name resolution')
        self.assertTrue(_looks_like_name_resolution_error(err))


if __name__ == '__main__':
    unittest.main()