import copy
import datetime
import importlib.util
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
spec = importlib.util.spec_from_file_location('broker', pathlib.Path(__file__).with_name('codex_subscription_broker.py'))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
SHA = 'a' * 40
NOW = datetime.datetime(2026, 11, 15, 12, 0, tzinfo=datetime.timezone.utc)


def pending(user='github-actions[bot]', sha=SHA):
    return {'user': {'login': user}, 'body': b.MARKER.format(sha=sha) + '\n' + b.PENDING.format(sha=sha)}


class FakeAPI:
    def __init__(self):
        self.pr = {'number': 1, 'state': 'open', 'draft': False, 'user': {'login': 'owner'},
                   'head': {'sha': SHA, 'repo': {'full_name': 'owner/repo'}}}
        self.comments = [pending()]
        self.posted = []

    def __call__(self, path, body=None):
        if body is not None:
            self.posted.append(body)
            self.comments.append({'user': {'login': 'owner'}, **body})
            return {'id': 2}
        if '/comments?' in path:
            return self.comments
        return copy.deepcopy(self.pr)


class BrokerTests(unittest.TestCase):
    def test_request_uses_native_subscription_trigger_once_per_head(self):
        api = FakeAPI()
        self.assertEqual(b.dispatch(api, 'owner/repo', api.pr, 'owner', NOW), 'requested')
        self.assertEqual(b.dispatch(api, 'owner/repo', api.pr, 'owner', NOW), 'already_requested')
        self.assertEqual(len(api.posted), 1)
        self.assertTrue(api.posted[0]['body'].startswith('@codex review\n'))
        self.assertIn('Advisory only', api.posted[0]['body'])

    def test_untrusted_marker_cannot_spend_subscription_allowance(self):
        api = FakeAPI()
        api.comments = [pending('attacker')]
        self.assertEqual(b.dispatch(api, 'owner/repo', api.pr, 'owner', NOW), 'not_pending')
        self.assertEqual(api.posted, [])

    def test_passing_or_not_opted_in_primary_never_requests_codex(self):
        api = FakeAPI()
        api.comments = [{'user': {'login': 'github-actions[bot]'}, 'body': b.MARKER.format(sha=SHA) + '\nClaude: reviewed\npass'}]
        self.assertEqual(b.dispatch(api, 'owner/repo', api.pr, 'owner', NOW), 'not_pending')
        self.assertEqual(api.posted, [])

    def test_old_commit_markers_do_not_request_new_head(self):
        api = FakeAPI()
        api.comments = [pending(sha='b'*40)]
        self.assertEqual(b.dispatch(api, 'owner/repo', api.pr, 'owner', NOW), 'not_pending')

    def test_head_change_or_closure_before_post_prevents_stale_review(self):
        for change in ['head', 'closed']:
            api = FakeAPI()
            old = copy.deepcopy(api.pr)
            if change == 'head':
                api.pr['head']['sha'] = 'b'*40
            else:
                api.pr['state'] = 'closed'
            self.assertEqual(b.dispatch(api, 'owner/repo', old, 'owner', NOW), 'superseded')
            self.assertEqual(api.posted, [])

    def test_forks_drafts_and_dependabot_are_ineligible(self):
        for case in ['fork', 'draft', 'dependabot']:
            api = FakeAPI()
            if case == 'fork': api.pr['head']['repo']['full_name'] = 'attacker/fork'
            if case == 'draft': api.pr['draft'] = True
            if case == 'dependabot': api.pr['user']['login'] = 'dependabot[bot]'
            self.assertEqual(b.dispatch(api, 'owner/repo', api.pr, 'owner', NOW), 'ineligible')
            self.assertEqual(api.posted, [])

    def test_killed_job_is_recovered_only_after_full_job_deadline(self):
        comment = {'user': {'login': 'github-actions[bot]'},
                   'body': b.MARKER.format(sha=SHA) + '\n' + b.RUNNING.format(sha=SHA),
                   'created_at': '2026-11-15T11:53:00Z'}
        self.assertFalse(b.needs_fallback([comment], SHA, NOW))
        comment['created_at'] = '2026-11-15T11:51:00Z'
        self.assertTrue(b.needs_fallback([comment], SHA, NOW))

    def test_existing_native_running_completed_and_failed_states_never_duplicate(self):
        for status in ['running', 'completed', 'failed']:
            state = b.json.dumps({'code_review': {'commit_sha': SHA, 'status': status}})
            comment = {'user': {'login': b.NATIVE_BOT}, 'body': '<!-- codex-review-state:v1 ' + state + ' -->'}
            self.assertTrue(b.already_requested([comment], SHA, 'owner'))
            comment['user']['login'] = 'attacker'
            self.assertFalse(b.already_requested([comment], SHA, 'owner'))

    def test_installation_token_is_not_mistaken_for_connected_chatgpt_user(self):
        with self.assertRaises(ValueError):
            b.run(lambda _: {'login': 'github-actions[bot]', 'type': 'Bot'})

    def test_missing_github_credential_never_uses_a_model_api(self):
        import os
        from unittest.mock import patch
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'ignored'}, clear=True), \
             patch.object(sys, 'argv', ['broker']), patch.object(b, 'run') as run:
            self.assertEqual(b.main(), 0)
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
