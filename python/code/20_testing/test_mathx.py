"""
═══════════════════════════════════════════════════════════════════

    20_testing —— 测试：unittest 与 pytest

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. unittest：标准库测试框架
 2. pytest：社区主流测试框架（⭐推荐）
 3. 表驱动测试（参数化测试）
 4. Mock 与测试替身
 5. 测试最佳实践

【运行】
    python -m pytest test_mathx.py -v              # 用 pytest 运行
    python -m pytest test_mathx.py -v --tb=short   # 简短错误信息
    python -m unittest test_mathx -v               # 用 unittest 运行

【与其他语言的对照】
  - Go：go test，表驱动测试，内置 testing.B 基准测试
  - Python unittest ≈ Java JUnit；pytest 更 Pythonic
  - pytest 的 fixture 系统是它最强大的特性（类似依赖注入）
  - pytest 的参数化测试 ≈ Go 的表驱动测试
"""
import unittest
from mathx import add, factorial, is_palindrome, fibonacci


# ═══════════════════════════════════════════════════════════════
# 第一部分：unittest 风格
# ═══════════════════════════════════════════════════════════════
class TestAdd(unittest.TestCase):
    """unittest 风格：继承 TestCase"""

    def test_positive_numbers(self):
        self.assertEqual(add(1, 2), 3)

    def test_negative_numbers(self):
        self.assertEqual(add(-1, -2), -3)

    def test_zero(self):
        self.assertEqual(add(0, 0), 0)

    def test_mixed(self):
        self.assertEqual(add(-1, 1), 0)


class TestFactorial(unittest.TestCase):

    def test_zero(self):
        self.assertEqual(factorial(0), 1)

    def test_one(self):
        self.assertEqual(factorial(1), 1)

    def test_five(self):
        self.assertEqual(factorial(5), 120)

    def test_large(self):
        self.assertEqual(factorial(10), 3628800)

    def test_negative_raises(self):
        """测试异常：assertRaises"""
        with self.assertRaises(ValueError):
            factorial(-1)

    def test_float_raises(self):
        with self.assertRaises(ValueError):
            factorial(3.14)


# ═══════════════════════════════════════════════════════════════
# 第二部分：pytest 风格（⭐推荐，更简洁）
# ═══════════════════════════════════════════════════════════════

# pytest 不需要类，直接写函数，函数名以 test_ 开头
def test_add_basic():
    assert add(1, 2) == 3

def test_add_strings():
    assert add("hello ", "world") == "hello world"


# ── 参数化测试（pytest 风格，≈ Go 的表驱动测试） ──
import pytest

@pytest.mark.parametrize("a, b, expected", [
    (1, 2, 3),
    (-1, -2, -3),
    (0, 0, 0),
    (100, -100, 0),
    (0.1, 0.2, pytest.approx(0.3)),   # ⭐ 浮点数用 approx 比较
])
def test_add_parametrized(a, b, expected):
    assert add(a, b) == expected


@pytest.mark.parametrize("s, expected", [
    ("racecar", True),
    ("hello", False),
    ("A man a plan a canal Panama", True),
    ("", True),
    ("a", True),
])
def test_is_palindrome(s, expected):
    assert is_palindrome(s) == expected


# ── 测试异常（pytest 风格） ──
def test_factorial_negative():
    with pytest.raises(ValueError, match="non-negative"):
        factorial(-1)


# ── Fixture（测试固件） ──
@pytest.fixture
def sample_fibonacci():
    """fixture 提供测试数据，可以在多个测试中复用"""
    return fibonacci(10)


def test_fibonacci_length(sample_fibonacci):
    assert len(sample_fibonacci) == 10


def test_fibonacci_first_elements(sample_fibonacci):
    assert sample_fibonacci[:6] == [0, 1, 1, 2, 3, 5]


def test_fibonacci_empty():
    assert fibonacci(0) == []


# ═══════════════════════════════════════════════════════════════
# 第三部分：Mock 测试替身
# ═══════════════════════════════════════════════════════════════
from unittest.mock import patch, MagicMock


def fetch_user_name(user_id):
    """模拟一个需要网络请求的函数"""
    import urllib.request
    url = f"https://api.example.com/users/{user_id}"
    with urllib.request.urlopen(url) as resp:
        import json
        return json.loads(resp.read())["name"]


def test_fetch_user_with_mock():
    """用 Mock 替换网络请求"""
    mock_response = MagicMock()
    mock_response.read.return_value = b'{"name": "Alice"}'
    mock_response.__enter__ = lambda s: s
    mock_response.__exit__ = MagicMock(return_value=False)

    with patch("urllib.request.urlopen", return_value=mock_response):
        result = fetch_user_name(1)
        assert result == "Alice"


# ═══════════════════════════════════════════════════════════════
# 运行入口
# ═══════════════════════════════════════════════════════════════
if __name__ == "__main__":
    # 用 unittest 运行（也可以用 pytest）
    unittest.main(verbosity=2)
