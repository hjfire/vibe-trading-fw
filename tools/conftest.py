"""Fork-owned pytest hooks for the ``tools/`` guard suites.

这里只有一件事：注册 ``local_archive`` 这个标记。它必须放在 conftest 里而不是
``test_wiki_drift.py`` 里 —— 测试模块是在 collection 阶段才被导入的，那时 pytest
早已解析完 marks，模块内的 ``pytest_configure`` 根本不会被调用，标记于是始终未知，
CI 每一轮都会打印 ``PytestUnknownMarkWarning``（本机实测：钩子写在测试模块里是
``1 passed, 1 deselected, 1 warning``，写在这个 conftest 里是 ``1 passed, 1 deselected``，
且 ``pytest --markers`` 能列出 ``local_archive``）。未注册的标记还会让一个拼错的
标记名静默地「谁都没选中」。上游 ``pyproject.toml`` 的 ``markers`` 表归上游所有，
按本仓「上游文件逐字不动」的规则不改；``tools/conftest.py`` 影响不到上游自己的
``agent/tests`` 运行（那条路径不会加载本目录的 conftest）。
"""


def pytest_configure(config):
    config.addinivalue_line("markers",
                            "local_archive: needs the untracked .qoder export archive on disk")
