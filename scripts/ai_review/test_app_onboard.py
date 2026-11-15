import importlib.util
import pathlib
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('app_onboard', pathlib.Path(__file__).with_name('app_onboard.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class AppOnboardTests(unittest.TestCase):
    def test_signing_key_is_private_and_not_in_arguments_or_environment(self):
        def sign(command, **kwargs):
            key_file = pathlib.Path(command[-1])
            self.assertEqual(key_file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(key_file.read_text(), 'test-key-only')
            self.assertNotIn('test-key-only', str(command))
            self.assertNotIn('AI_REVIEW_APP_PRIVATE_KEY', kwargs['env'])
            return subprocess.CompletedProcess(command, 0, stdout=b'signed')
        with patch.object(m.subprocess, 'run', side_effect=sign):
            self.assertEqual(len(m.jwt('123', 'test-key-only').split('.')), 3)

    def test_fresh_token_per_owner_without_passing_signing_key(self):
        def api(path, token, method='GET', body=None):
            if path.startswith('/app/installations?'):
                return [{'id': 1, 'account': {'login': 'personal'}},
                        {'id': 2, 'account': {'login': 'organization'}}]
            self.assertEqual(body['permissions']['workflows'], 'write')
            return {'token': 'short-lived-test-token'}
        def reconcile(command, **kwargs):
            self.assertIn('--redact-private', command)
            self.assertEqual(kwargs['env']['AI_REVIEW_AUTH_MODE'], 'installation')
            self.assertEqual(kwargs['env']['AI_REVIEW_ADMIN_TOKEN'], 'short-lived-test-token')
            self.assertNotIn('AI_REVIEW_APP_PRIVATE_KEY', kwargs['env'])
            self.assertNotIn('GITHUB_TOKEN', kwargs['env'])
            return subprocess.CompletedProcess(command, 0, stdout='[]')
        with patch.dict(m.os.environ, {'AI_REVIEW_APP_ID': '123', 'AI_REVIEW_APP_PRIVATE_KEY': 'test-key-only'}, clear=True), \
             patch.object(m, 'jwt', return_value='test-jwt'), patch.object(m, 'api', side_effect=api), \
             patch.object(m.subprocess, 'run', side_effect=reconcile) as child:
            self.assertEqual(m.run('a'*40), 0)
            self.assertEqual(child.call_count, 2)


if __name__ == '__main__':
    unittest.main()
