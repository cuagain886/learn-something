"""mathx —— 被测试的模块"""


def add(a, b):
    """两数相加"""
    return a + b


def factorial(n):
    """阶乘，n 必须是非负整数"""
    if not isinstance(n, int) or n < 0:
        raise ValueError(f"n must be a non-negative integer, got {n}")
    if n <= 1:
        return 1
    return n * factorial(n - 1)


def is_palindrome(s):
    """判断字符串是否是回文"""
    cleaned = s.lower().replace(" ", "")
    return cleaned == cleaned[::-1]


def fibonacci(n):
    """返回前 n 个斐波那契数"""
    if n <= 0:
        return []
    result = []
    a, b = 0, 1
    for _ in range(n):
        result.append(a)
        a, b = b, a + b
    return result
