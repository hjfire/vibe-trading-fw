"""前端自定义档文法的对账针：前端只许产出服务端认得的拼写。

两枚测试（这份 ＋ `frontend/src/lib/__tests__/customInterval.test.ts`）各自逐字
抄一遍同一批串，谁也不 import 谁——共享夹具会让「前后端对齐」退化成自证。
"""

import pytest

from src.api.interval_spec import parse_interval

#: 文法桶：两侧都必须接受。前端产出的每一条都得落在这里。
AGREED_OK = ["5m", "7m", "120m", "240m", "999m", "2D", "3W", "4M", "12M", "1m", "1D", "1W", "1M"]
#: 文法桶：两侧都必须拒绝。
AGREED_REJECT = ["", " ", "abc", "m", "0m", "-5m", "2.5m", "1d", "120X", "1S", "1tick", "2h", "M", "D"]
#: 边界桶：服务端受、前端拒。前端多出的那把尺是本仓自己的规则（spec §4），
#: 这一桶**只登记差异**，不许被当成「前后端不一致」的缺陷，也不许拿它推对面。
FRONTEND_ONLY_REJECT = ["1000m", "1441m", "367D", "400W", "500M"]


@pytest.mark.parametrize("text", AGREED_OK)
def test_agreed_ok_round_trips_as_itself(text):
    assert parse_interval(text) is not None, text
    assert parse_interval(text).interval == text, text


@pytest.mark.parametrize("text", AGREED_REJECT)
def test_agreed_reject_is_refused(text):
    assert parse_interval(text) is None, text


@pytest.mark.parametrize("text", FRONTEND_ONLY_REJECT)
def test_frontend_cap_is_stricter_than_the_server(text):
    """登记在册的那把额外的尺：服务端收，前端不收。改了这里要先改前端。"""
    assert parse_interval(text) is not None, text
