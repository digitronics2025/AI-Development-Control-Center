#!/usr/bin/env python3
"""Dispatch native Codex reviews with a connected GitHub user's credential.

No model API, ChatGPT cookie, refresh token or PR checkout is involved. Only
GitHub metadata and comments are read. Public workflow logs contain counts only.
"""
import argparse
import datetime
import json
import os
import re
import urllib.request
from reviewer import MARKER, PENDING, RUNNING

REQUESTED = '<!-- codex-subscription-request:v1:{sha} -->'
NATIVE_BOT = 'chatgpt-codex-connector[bot]'
STATE = re.compile(r'codex-review-state:v1 (\{.*?\}) -->', re.S)


class API:
    def __init__(self, token):
        self.token = token
        self.calls = 0

    def __call__(self, path, body=None):
        if not path.startswith('/') or path.startswith('//'):
            raise ValueError('invalid GitHub API path')
        self.calls += 1
        if self.calls > 600:
            raise RuntimeError('GitHub API budget exhausted')
        req = urllib.request.Request('https://api.github.com' + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization': 'Bearer ' + self.token,
                     'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json',
                     'User-Agent': 'subscription-review-dispatcher'})
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.load(response)


def pages(api, path):
    for page in range(1, 11):
        batch = api(path + ('&' if '?' in path else '?') + f'per_page=100&page={page}')
        yield from batch
        if len(batch) < 100:
            return
    raise RuntimeError('pagination budget exhausted')


def needs_fallback(comments, sha, now):
    """Only the trusted runner can queue reviews; old/injected markers don't count."""
    for comment in comments:
        if comment.get('user', {}).get('login') != 'github-actions[bot]':
            continue
        body = comment.get('body', '')
        if MARKER.format(sha=sha) not in body:
            continue
        if PENDING.format(sha=sha) in body:
            return True
        # A lost/timed-out review cannot update its claim. The maximum review
        # job is seven minutes; only recover explicit running claims after eight.
        if RUNNING.format(sha=sha) in body:
            try:
                created = datetime.datetime.fromisoformat(comment['created_at'].replace('Z', '+00:00'))
                if now - created >= datetime.timedelta(minutes=8):
                    return True
            except (ValueError, KeyError):
                pass
    return False


def already_requested(comments, sha, actor):
    for comment in comments:
        login = comment.get('user', {}).get('login')
        body = comment.get('body', '')
        if login == actor and REQUESTED.format(sha=sha) in body:
            return True
        if login == NATIVE_BOT:
            match = STATE.search(body)
            if match:
                try:
                    state = json.loads(match[1].replace('&#123;', '{').replace('&#125;', '}'))['code_review']
                    if state.get('commit_sha') == sha and state.get('status') in ('running', 'completed', 'failed'):
                        return True
                except (ValueError, KeyError, TypeError):
                    pass
    return False


def dispatch(api, full, pr, actor, now):
    number = pr['number']
    sha = pr['head']['sha']
    if (pr['state'] != 'open' or pr.get('draft') or
        (pr['head'].get('repo') or {}).get('full_name') != full or
        pr.get('user', {}).get('login') == 'dependabot[bot]'):
        return 'ineligible'
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        return 'ineligible'
    comments = list(pages(api, f'/repos/{full}/issues/{number}/comments'))
    if already_requested(comments, sha, actor):
        return 'already_requested'
    if not needs_fallback(comments, sha, now):
        return 'not_pending'
    # Refuse to ask for an obsolete revision after a push, closure or fork.
    current = api(f'/repos/{full}/pulls/{number}')
    if (current['state'] != 'open' or current.get('draft') or current['head']['sha'] != sha or
        (current['head'].get('repo') or {}).get('full_name') != full):
        return 'superseded'
    # The request itself is the durable claim. A network timeout after POST
    # must not be retried in this run; the next run re-reads the comments first.
    api(f'/repos/{full}/issues/{number}/comments', {'body':
        '@codex review\n\n' + REQUESTED.format(sha=sha) + '\n'
        'Claude was unavailable or a second opinion was requested. '
        'Use the connected ChatGPT subscription. Advisory only: merging and '
        'deployment do not wait for any AI response or finding.'})
    return 'requested'


def run(api, only_repositories=None):
    identity = api('/user')
    actor = identity.get('login', '')
    if identity.get('type') != 'User' or not actor or actor.endswith('[bot]'):
        raise ValueError('a connected GitHub user credential is required, not an installation token')
    expected_actor = os.getenv('CODEX_REVIEW_GITHUB_USER') or os.getenv('GITHUB_REPOSITORY_OWNER')
    if expected_actor and actor != expected_actor:
        raise ValueError('the token must belong to the connected GitHub user')
    approved_owners = set(json.loads(os.getenv('CODEX_REVIEW_OWNERS', '[]') or '[]'))
    counters = {'repositories': 0, 'requested': 0, 'already_requested': 0,
                'not_pending': 0, 'ineligible': 0, 'superseded': 0, 'restricted': 0}
    now = datetime.datetime.now(datetime.timezone.utc)
    repositories = list(pages(api, '/user/repos?affiliation=owner,collaborator,organization_member'))
    for repo in repositories:
        full = repo['full_name']
        if (only_repositories and full not in only_repositories) or (approved_owners and repo['owner']['login'] not in approved_owners):
            continue
        if repo.get('archived') or repo.get('disabled') or not any(repo.get('permissions', {}).get(p) for p in ('admin', 'maintain')):
            continue
        counters['repositories'] += 1
        try:
            pulls = list(pages(api, f'/repos/{full}/pulls?state=open'))
            for pr in pulls:
                try:
                    counters[dispatch(api, full, pr, actor, now)] += 1
                except Exception:
                    counters['restricted'] += 1
        except Exception:
            counters['restricted'] += 1
    # No private repository names, PR URLs, source, or credential values.
    print(json.dumps(counters))
    return counters


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repository', action='append', default=[])
    args = parser.parse_args()
    token = os.getenv('CODEX_REVIEW_GITHUB_TOKEN', '')
    if not token:
        print('Subscription fallback dispatcher inactive: configure CODEX_REVIEW_GITHUB_TOKEN. No paid AI API will be used.')
        return 0
    try:
        counters = run(API(token), set(args.repository) or None)
        return 1 if counters['restricted'] else 0
    except Exception as error:
        print('Subscription dispatcher unavailable (' + type(error).__name__ + '); merges and deployments remain independent.')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
