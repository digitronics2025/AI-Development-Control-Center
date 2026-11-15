import copy
import importlib.util
import pathlib
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('reviewer', pathlib.Path(__file__).with_name('reviewer.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
PASS = {'verdict': 'pass', 'summary': 'No concrete issues in the supplied diff.'}
FINDINGS = {'verdict': 'findings', 'summary': 'a.py:2: division by zero.'}


class FakeGitHub:
    def __init__(self):
        self.pr = {'state': 'open', 'draft': False, 'user': {'login': 'owner'}, 'labels': [],
                   'head': {'sha': 'a' * 40, 'repo': {'full_name': 'owner/repo'}},
                   'base': {'repo': {'full_name': 'owner/repo'}}}
        self.comments = []
        self.posts = []
        self.updates = []

    def get(self, path):
        if '/files?' in path:
            return [{'filename': 'a.py', 'patch': '+ untrusted $(echo injection) @all'}]
        if '/comments?' in path:
            return self.comments
        return copy.deepcopy(self.pr)

    def post(self, path, data):
        self.posts.append(data)
        self.comments.append({'user': {'login': 'github-actions[bot]'}, **data})
        return {'id': 1}

    def patch_comment(self, comment_id, body):
        self.updates.append(body)


class ReviewTests(unittest.TestCase):
    def scenario(self, primary, fallback=PASS, second=False):
        def invoke(value):
            if isinstance(value, Exception):
                raise value
            return value
        with patch.object(r, 'claude', side_effect=lambda _: invoke(primary)) as c, \
             patch.object(r, 'codex', side_effect=lambda _: invoke(fallback)) as x:
            result = r.evaluate('untrusted diff', second, c, x)
        return result, c.call_count, x.call_count

    def test_success_uses_only_claude(self):
        result, c, x = self.scenario(PASS)
        self.assertEqual((len(result), c, x), (1, 1, 0))

    def test_negative_review_does_not_trigger_default_second_opinion(self):
        self.assertEqual(self.scenario(FINDINGS)[2], 0)

    def test_opt_in_second_opinion_on_findings(self):
        result, c, x = self.scenario(FINDINGS, second=True)
        self.assertEqual((c, x, result[1]['provider']), (1, 1, 'Codex'))

    def test_second_opinion_does_not_duplicate_a_passing_review(self):
        self.assertEqual(self.scenario(PASS, second=True)[2], 0)

    def test_claude_failure_auth_quota_and_service_fall_back_once(self):
        for error in [RuntimeError('auth'), RuntimeError('quota'), RuntimeError('503')]:
            result, c, x = self.scenario(error)
            self.assertEqual((c, x, result[1]['status']), (1, 1, 'reviewed'))

    def test_timeout_falls_back_once(self):
        for error in [TimeoutError(), subprocess.TimeoutExpired('claude', 1)]:
            self.assertEqual(self.scenario(error)[1:], (1, 1))

    def test_both_fail_is_advisory_data(self):
        result, c, x = self.scenario(RuntimeError('SECRET'), TimeoutError())
        self.assertEqual([v['status'] for v in result], ['unavailable', 'unavailable'])
        self.assertNotIn('SECRET', str(result))
        self.assertEqual((c, x), (1, 1))

    def test_missing_credentials_return_without_raising(self):
        with patch.dict(r.os.environ, {}, clear=True):
            result = r.evaluate('diff')
        self.assertEqual([v['status'] for v in result], ['unavailable', 'unavailable'])

    def test_incomplete_or_invalid_output_is_failure(self):
        for output in ['', '{}', '{"verdict":"approve","summary":"fine"}']:
            with self.assertRaises((ValueError, KeyError)):
                r.parse_review(output)

    def test_deduplicates_all_reruns_including_missing_response(self):
        gh = FakeGitHub()
        with patch.object(r, 'evaluate', return_value=[]) as evaluate:
            r.run_review(gh, 1)
            self.assertIn('already claimed', r.run_review(gh, 1))
            self.assertEqual(evaluate.call_count, 1)
            self.assertEqual(len(gh.posts), 1)

    def test_untrusted_cannot_spoof_a_claim(self):
        gh = FakeGitHub()
        gh.comments = [{'user': {'login': 'attacker'}, 'body': r.MARKER.format(sha='a'*40)}]
        with patch.object(r, 'evaluate', return_value=[]):
            self.assertEqual(r.run_review(gh, 1), 'advisory review recorded')

    def test_forks_drafts_and_dependabot_never_call_providers(self):
        for kind in ['fork', 'draft', 'dependabot']:
            gh = FakeGitHub()
            if kind == 'fork':
                gh.pr['head']['repo']['full_name'] = 'attacker/repo'
            elif kind == 'draft':
                gh.pr['draft'] = True
            else:
                gh.pr['user']['login'] = 'dependabot[bot]'
            with patch.object(r, 'evaluate') as evaluate:
                self.assertTrue(r.run_review(gh, 1).startswith('skipped:'))
                evaluate.assert_not_called()
            self.assertEqual(gh.posts, [])

    def test_github_outage_has_successful_process_exit(self):
        with patch.dict(r.os.environ, {'PR_NUMBER': '1', 'GITHUB_REPOSITORY': 'owner/repo', 'GH_TOKEN': 'test'}), \
             patch.object(r.GitHub, 'get', side_effect=TimeoutError()):
            self.assertEqual(r.main(), 0)

    def test_negative_review_is_plain_comment_not_change_request(self):
        gh = FakeGitHub()
        with patch.object(r, 'evaluate', return_value=[{'provider': 'Claude', 'status': 'reviewed', **FINDINGS}]):
            r.run_review(gh, 1)
        self.assertIn('Merging and deployment do not depend', gh.updates[0])
        self.assertNotIn('REQUEST_CHANGES', gh.updates[0])


if __name__ == '__main__':
    unittest.main()
