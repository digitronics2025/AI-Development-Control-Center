#!/usr/bin/env python3
"""Mint short-lived, installation-scoped tokens for scheduled onboarding."""
import base64
import json
import os
import pathlib
import subprocess
import tempfile
import time
import urllib.request


def encoded(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode()


def jwt(app_id, private_key):
    if not str(app_id).isdigit():
        raise ValueError('App ID must be numeric')
    now = int(time.time())
    unsigned = encoded(b'{"alg":"RS256","typ":"JWT"}') + '.' + encoded(
        json.dumps({'iat': now - 60, 'exp': now + 540, 'iss': str(app_id)}).encode())
    with tempfile.TemporaryDirectory(prefix='ai-onboard-key-') as work:
        key_file = pathlib.Path(work) / 'signing-key'
        fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write(private_key)
        env = {k: os.environ[k] for k in ('PATH',) if k in os.environ}
        signed = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', str(key_file)],
                                input=unsigned.encode(), capture_output=True,
                                timeout=10, check=True, env=env)
    return unsigned + '.' + encoded(signed.stdout)


def api(path, token, method='GET', body=None):
    req = urllib.request.Request('https://api.github.com' + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                 'Content-Type': 'application/json', 'User-Agent': 'advisory-ai-onboarding'})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def run(workflow_sha):
    signer = jwt(os.environ['AI_REVIEW_APP_ID'], os.environ['AI_REVIEW_APP_PRIVATE_KEY'])
    owners = set(json.loads(os.getenv('AI_REVIEW_OWNERS', '[]') or '[]'))
    installations = []
    for page in range(1, 101):
        batch = api(f'/app/installations?per_page=100&page={page}', signer)
        installations.extend(batch)
        if len(batch) < 100:
            break
    else:
        raise RuntimeError('installation pagination budget exhausted')
    failed = False
    for installation in installations:
        owner = installation['account']['login']
        if installation.get('suspended_at') or (owners and owner not in owners):
            continue
        try:
            token = api(f'/app/installations/{installation["id"]}/access_tokens', signer, 'POST',
                        {'permissions': {'contents': 'write', 'workflows': 'write', 'pull_requests': 'write'}})['token']
            # Long-lived signing credentials never reach repository reconciliation.
            env = {k: v for k, v in os.environ.items() if k not in
                   ('AI_REVIEW_APP_PRIVATE_KEY', 'AI_REVIEW_ADMIN_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN')}
            env.update(AI_REVIEW_ADMIN_TOKEN=token, AI_REVIEW_AUTH_MODE='installation')
            result = subprocess.run(['python3', str(pathlib.Path(__file__).with_name('onboard.py')),
                                     '--apply', '--workflow-sha', workflow_sha],
                                    env=env, capture_output=True, text=True, timeout=900)
            try:
                report = json.loads(result.stdout)
            except ValueError:
                report = [{'status': 'reconciler unavailable'}]
            print(json.dumps({'owner': owner, 'repositories': report}), flush=True)
            failed |= result.returncode != 0
        except Exception as exc:
            print(json.dumps({'owner': owner, 'status': 'restricted', 'error': type(exc).__name__}), flush=True)
            failed = True
    return 1 if failed else 0


if __name__ == '__main__':
    try:
        import sys
        raise SystemExit(run(sys.argv[1]))
    except Exception as exc:
        print('GitHub App onboarding unavailable (' + type(exc).__name__ + ').')
        raise SystemExit(1)
