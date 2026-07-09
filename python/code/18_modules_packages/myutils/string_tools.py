"""myutils.string_tools —— 字符串工具模块"""


def reverse_string(s):
    """反转字符串"""
    return s[::-1]


def is_palindrome(s):
    """判断回文"""
    cleaned = s.lower().replace(" ", "")
    return cleaned == cleaned[::-1]


def truncate(s, max_len=50, suffix="..."):
    """截断字符串"""
    if len(s) <= max_len:
        return s
    return s[:max_len - len(suffix)] + suffix


if __name__ == "__main__":
    print(f"reverse: {reverse_string('hello')}")
    print(f"palindrome 'racecar': {is_palindrome('racecar')}")
    print(f"truncate: {truncate('Hello, World!', 8)}")
