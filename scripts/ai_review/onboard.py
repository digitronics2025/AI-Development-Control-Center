#!/usr/bin/env python3
"""Reconcile approved owners' callers. Never bypass branch/human protections.

Needs an all-repository GitHub App installation token or fine-grained PAT with
Contents/Workflows write and Pull requests write. The review runner never gets it.
"""
import argparse
import base64
import json
import os
import pathlib
import re
import urllib.error
import urllib.request

HUB = 'digitronics2025/AI-Development-Control-Center'
TARGET = '.github/workflows/claude-fallback-review.yml'


def api(path, method='GET', data=None):
    token = os.environ['AI_REVIEW_ADMIN_TOKEN']
    request = urllib.request.Request('https://api.github.com' + path, method=method,
              headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                       'Content-Type': 'application/json', 'User-Agent': 'advisory-ai-onboarding'},
              data=None if data is None else json.dumps(data).encode())
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def pages(path):
    result = []
    for page in range(1, 101):
        batch = api(path + ('&' if '?' in path else '?') + f'per_page=100&page={page}')
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise RuntimeError('inventory pagination budget exhausted')


def render(sha, config=None):
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('workflow ref must be a full immutable SHA')
    config = config or {}
    trigger = config.get('trigger', 'pull_request_target')
    template = 'caller.yml'
    if trigger == 'workflow_run':
        workflows = config.get('workflows', [])
        if not 1 <= len(workflows) <= 10 or any(not isinstance(w, str) or not re.fullmatch(r'[A-Za-z0-9 ._/-]{1,80}', w) for w in workflows):
            raise ValueError('workflow_run requires explicit safe CI workflow names')
        template = 'caller-ci-complete.yml'
    elif trigger != 'pull_request_target':
        raise ValueError('unsupported review trigger')
    content = pathlib.Path(__file__).parents[2].joinpath('templates/ai-review', template).read_text().replace('REVIEW_WORKFLOW_SHA', sha)
    if trigger == 'workflow_run':
        content = content.replace('REVIEW_CI_WORKFLOWS', json.dumps(workflows))
    return content


def redact_private(report, repositories):
    private = {r['full_name']: r.get('private', True) for r in repositories}
    return [{'repo': 'private repository (redacted)', 'status': entry['status']}
            if private.get(entry['repo'], True) else entry for entry in report]


def reconcile(repo, content, apply=False):
    full = repo['full_name']
    if repo.get('archived') or repo.get('disabled') or not repo.get('size'):
        return {'repo': full, 'status': 'ineligible: archived, disabled or empty'}
    if not repo.get('permissions', {}).get('push'):
        return {'repo': full, 'status': 'restricted: no contents write permission'}
    base = repo['default_branch']
    try:
        old = api(f'/repos/{full}/contents/{TARGET}?ref={base}')
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise
        old = None
    if old and base64.b64decode(old['content']).decode() == content:
        return {'repo': full, 'status': 'caller current'}
    if not apply:
        return {'repo': full, 'status': 'update planned'}
    data = {'message': 'ci: make AI review advisory with automatic failover',
            'branch': base, 'content': base64.b64encode(content.encode()).decode()}
    if old:
        data['sha'] = old['sha']
    try:
        result = api(f'/repos/{full}/contents/{TARGET}', 'PUT', data)
        return {'repo': full, 'status': 'caller deployed', 'commit': result['commit']['sha']}
    except urllib.error.HTTPError as exc:
        # A protected repository gets a normal PR. No rules are weakened and
        # no administrative bypass or automatic human approval is attempted.
        if exc.code not in (403, 409, 422):
            raise
        branch = 'ci/advisory-ai-review'
        ref = api(f'/repos/{full}/git/ref/heads/{base}')
        try:
            api(f'/repos/{full}/git/refs', 'POST', {'ref': 'refs/heads/' + branch, 'sha': ref['object']['sha']})
        except urllib.error.HTTPError as branch_error:
            if branch_error.code != 422:
                raise
        branch_old = None
        try:
            branch_old = api(f'/repos/{full}/contents/{TARGET}?ref={branch}')
        except urllib.error.HTTPError as old_error:
            if old_error.code != 404:
                raise
        data['branch'] = branch
        if branch_old:
            data['sha'] = branch_old['sha']
        else:
            data.pop('sha', None)
        api(f'/repos/{full}/contents/{TARGET}', 'PUT', data)
        pulls = api(f'/repos/{full}/pulls?state=open&head={repo["owner"]["login"]}:{branch}')
        if pulls:
            pr = pulls[0]
        else:
            pr = api(f'/repos/{full}/pulls', 'POST', {'head': branch, 'base': base,
                     'title': 'ci: advisory AI review with automatic failover',
                     'body': 'Moves AI review outside merge and deployment gates. Claude is primary; Codex runs on failure or an opted-in second opinion. Existing CI and human approval requirements remain in force.'})
        return {'repo': full, 'status': 'normal PR required', 'pr': pr['html_url']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--workflow-sha', required=True)
    parser.add_argument('--redact-private', action='store_true')
    args = parser.parse_args()
    # The owner authorized personal and managed organization repositories.
    # An optional allowlist can narrow that scope; push-only collaborators are
    # not automatically treated as repository managers.
    owners = set(json.loads(os.getenv('AI_REVIEW_OWNERS', '[]') or '[]'))
    render(args.workflow_sha)  # validate the released ref before any mutation
    report = []
    if os.getenv('AI_REVIEW_AUTH_MODE') == 'installation':
        repositories = []
        for page in range(1, 101):
            batch = api(f'/installation/repositories?per_page=100&page={page}')['repositories']
            for repo in batch:
                # Selected repositories are the installation's explicit grant.
                repo['permissions'] = {'push': True, 'maintain': True}
            repositories.extend(batch)
            if len(batch) < 100:
                break
        else:
            raise RuntimeError('installation pagination budget exhausted')
    else:
        repositories = pages('/user/repos?affiliation=owner,collaborator,organization_member')
    for repo in repositories:
        if owners and repo['owner']['login'] not in owners:
            report.append({'repo': repo['full_name'], 'status': 'outside approved owner allowlist'})
            continue
        if not any(repo.get('permissions', {}).get(p) for p in ('admin', 'maintain')):
            report.append({'repo': repo['full_name'], 'status': 'ineligible: not an owner or manager'})
            continue
        try:
            config = {}
            try:
                entry = api(f'/repos/{repo["full_name"]}/contents/.github/advisory-ai-review.json?ref={repo["default_branch"]}')
                config = json.loads(base64.b64decode(entry['content']))
            except urllib.error.HTTPError as config_error:
                if config_error.code != 404:
                    raise
            report.append(reconcile(repo, render(args.workflow_sha, config), args.apply))
        except urllib.error.HTTPError as exc:
            report.append({'repo': repo['full_name'], 'status': f'restricted: GitHub HTTP {exc.code}'})
        except (ValueError, TypeError) as exc:
            report.append({'repo': repo['full_name'], 'status': 'restricted: invalid review configuration'})
    if args.redact_private:
        report = redact_private(report, repositories)
    print(json.dumps(report, indent=2))
    # This reconciler handles caller distribution only. Existing AI merge gates
    # must be audited before declaring a repository fully nonblocking.
    return 1 if any(x['status'].startswith('restricted:') for x in report) else 0


if __name__ == '__main__':
    raise SystemExit(main())
