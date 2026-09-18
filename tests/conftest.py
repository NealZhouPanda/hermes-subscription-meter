"""Real pytest isolation fixtures for the subscription-meter backend tests.

- ``isolate_env``: every test (and module import) sees a temp ``HERMES_HOME``
  plus a stripped credential environment, so nothing reads or writes the real
  ``~/.hermes`` tree. The original environment is restored afterwards.
- ``block_network``: any outbound socket attempt fails immediately, keeping
  the whole suite offline.
"""

import os
import socket

import pytest


@pytest.fixture(autouse=True)
def isolate_env(tmp_path, monkeypatch):
    hermes_home = tmp_path / ".hermes-home"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setenv("SUBSCRIPTION_METER_TEST_ISOLATED", "1")
    # Strip credential-ish variables for the duration of each test.
    for name in list(os.environ):
        if name.startswith(("KIMI_", "GLM_", "DEEPSEEK_", "XAI_", "NOUS_", "ALIBABA_CLOUD_", "DASHSCOPE_")):
            monkeypatch.delenv(name, raising=False)
    yield
    # monkeypatch restores the environment itself; nothing to undo manually.


@pytest.fixture(autouse=True)
def block_network(monkeypatch):
    def _blocked(self, *args, **kwargs):
        raise AssertionError("outbound network connect is not allowed in subscription-meter tests")

    # Only block real outbound connects; creating loop-internal sockets
    # (asyncio self-pipe, socketpair) keeps working.
    monkeypatch.setattr(socket.socket, "connect", _blocked)
    yield
