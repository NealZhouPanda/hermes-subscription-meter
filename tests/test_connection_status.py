import os
from pathlib import Path
import pytest
from tests.conftest_sm import plugin_api as api
from tests.conftest_sm import write_auth, write_env


def test_credentials_are_read_from_active_profile_without_parent_environment(monkeypatch, tmp_path):
    monkeypatch.setattr(api, 'HERMES_ENV', tmp_path / 'absent-default.env', raising=False)
    profile = tmp_path / 'profile'
    profile.mkdir()
    (profile / '.env').write_text('GLM_API_KEY=profile-fixture\n')
    monkeypatch.setenv('HERMES_HOME', str(profile))
    monkeypatch.setenv('GLM_API_KEY', 'parent-fixture')
    monkeypatch.setenv('DEEPSEEK_API_KEY', 'parent-must-not-leak')
    assert api._read_env_key('GLM_API_KEY') == 'profile-fixture'
    assert api._read_env_key('DEEPSEEK_API_KEY') == ''


def test_rows_classify_errors_without_exposing_provider_messages():
    from urllib.error import HTTPError
    missing = api._row('glm', 'GLM', error=api.MissingCredentialError('secret-fixture'))
    denied = api._row('glm', 'GLM', error=HTTPError('https://fixture.invalid', 401, 'secret-fixture', {}, None))
    failed = api._row('glm', 'GLM', error=TimeoutError('secret-fixture'))
    good = api._row('glm', 'GLM', usedPercent=20)
    assert [r.status for r in (missing, denied, failed, good)] == ['unconfigured','auth_error','request_error','ok']
    assert all('secret-fixture' not in r.model_dump_json() for r in (missing,denied,failed))
    assert 'GLM_API_KEY' in missing.actionHint


def test_settings_reports_last_checked_state_without_network(monkeypatch):
    from urllib.error import HTTPError
    write_env({"KIMI_API_KEY": "sk-kimi-fixture", "GLM_API_KEY": "glm-fixture"})
    monkeypatch.setattr(api, '_read_plugin_settings', lambda: {'visibility': {'kimi': False}})
    monkeypatch.setattr(api, '_cache', {'at': 0, 'payload': None, 'identity_overrides': {}})
    first = {p.id:p for p in api.get_provider_settings().providers}
    assert first['kimi'].status == 'disabled'
    assert first['glm'].status == 'unknown'
    api._cache['payload'] = api.MeterPayload(rows=[api._row('glm','GLM',error=HTTPError('fixture',403,'fixture',{},None))])
    later = {p.id:p for p in api.get_provider_settings().providers}
    assert later['glm'].status == 'auth_error'
    assert later['glm'].checkedAt is not None
    assert 'GLM_API_KEY' in later['glm'].actionHint


def test_empty_bearer_is_unconfigured_before_network():
    with pytest.raises(api.MissingCredentialError):
        api._json_get('https://fixture.invalid', '')


def test_deepseek_balance_survives_missing_optional_platform_token(monkeypatch):
    monkeypatch.setattr(api, '_platform_token', lambda: '')
    monkeypatch.setattr(api, '_read_env_key', lambda name: 'fixture-key' if name == 'DEEPSEEK_API_KEY' else '')
    calls = []
    def response(url, token):
        calls.append(url)
        assert url == api.DEEPSEEK_BALANCE_URL
        return {'is_available': True, 'balance_infos':[{'total_balance':'12.5','currency':'CNY'}]}
    monkeypatch.setattr(api, '_json_get', response)
    row = api._fetch_deepseek(1_800_000_000)
    assert row.balance == 12.5
    assert row.todaySpend is None and row.sevenDaySpend is None and row.thirtyDaySpend is None
    assert row.status == 'partial' and row.error is None
    assert len(calls) == 1


def test_platform_token_never_scans_browser_implicitly(monkeypatch):
    monkeypatch.setattr(api, '_read_env_key', lambda name: '')
    def forbidden(*args, **kwargs):
        raise AssertionError('must not read browser storage')
    monkeypatch.setattr(api.subprocess, 'run', forbidden)
    assert api._platform_token() == ''


def test_refresh_endpoint_bypasses_cached_payload(monkeypatch):
    import time
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    monkeypatch.setattr(api, '_cache', {'at':time.time(), 'payload':api.MeterPayload(generatedAt=1), 'identity_overrides': {}})
    app=FastAPI(); app.include_router(api.router)
    client=TestClient(app)
    assert client.get('/data').json()['generatedAt'] == 1
    assert client.get('/data?refresh=true').json()['generatedAt'] > 1




