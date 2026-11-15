import base64
import importlib.util
import pathlib
import unittest
import urllib.error
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('onboard', pathlib.Path(__file__).with_name('onboard.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class OnboardTests(unittest.TestCase):
    def setUp(self):
        self.repo = {'full_name': 'owner/repo', 'owner': {'login': 'owner'}, 'size': 1,
                     'default_branch': 'main', 'permissions': {'push': True}}

    def test_current_callers_are_no_op(self):
        old = {'content': base64.b64encode(b'wanted').decode(), 'sha': 'blob'}
        with patch.object(m, 'api', return_value=old) as api:
            self.assertEqual(m.reconcile(self.repo, 'wanted', True)['status'], 'caller current')
            self.assertEqual(api.call_count, 1)

    def test_default_is_read_only(self):
        with patch.object(m, 'api', return_value={'content': '', 'sha': 'old'}) as api:
            self.assertEqual(m.reconcile(self.repo, 'wanted')['status'], 'update planned')
            self.assertEqual(api.call_count, 1)

    def test_new_repository_gets_pinned_caller(self):
        error = urllib.error.HTTPError('https://api.github.com', 404, 'not found', {}, None)
        with patch.object(m, 'api', side_effect=[error, {'commit': {'sha': 'new'}}]) as api:
            self.assertEqual(m.reconcile(self.repo, 'wanted', True)['status'], 'caller deployed')
            payload = api.call_args.args[2]
            self.assertEqual(payload['branch'], 'main')
            self.assertNotIn('sha', payload)

    def test_protection_uses_pr_without_bypass(self):
        error = urllib.error.HTTPError('https://api.github.com', 409, 'protected', {}, None)
        old = {'content': '', 'sha': 'blob'}
        responses = [old, error, {'object': {'sha': 'head'}}, {}, old, {}, [], {'html_url': 'https://github.com/owner/repo/pull/1'}]
        with patch.object(m, 'api', side_effect=responses) as api:
            self.assertEqual(m.reconcile(self.repo, 'wanted', True)['status'], 'normal PR required')
            for call in api.call_args_list:
                self.assertNotIn('rulesets', call.args[0])
                self.assertNotIn('protection', call.args[0])

    def test_immutable_ref_required(self):
        with self.assertRaises(ValueError):
            m.render('main')
        self.assertIn('@' + 'a'*40, m.render('a'*40))

    def test_archived_repository_never_mutates(self):
        with patch.object(m, 'api') as api:
            self.repo['archived'] = True
            self.assertTrue(m.reconcile(self.repo, 'wanted', True)['status'].startswith('ineligible'))
            api.assert_not_called()

    def test_ci_completion_mode_preserves_stricter_secret_policy(self):
        content = m.render('a'*40, {'trigger': 'workflow_run', 'workflows': ['CI']})
        self.assertIn('  workflow_run:', content)
        self.assertNotIn('  pull_request_target:', content)
        self.assertIn('workflows: ["CI"]', content)
        self.assertIn('# v1 advisory review', content)
        with self.assertRaises(ValueError):
            m.render('a'*40, {'trigger': 'workflow_run', 'workflows': ['${{ injection }}']})


if __name__ == '__main__':
    unittest.main()
