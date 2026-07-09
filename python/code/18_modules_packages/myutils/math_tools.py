"""myutils.math_tools —— 数学工具模块"""


def add(a, b):
    """加法"""
    return a + b


def factorial(n):
    """阶乘（递归实现）"""
    if n <= 1:
        return 1
    return n * factorial(n - 1)


def is_prime(n):
    """判断素数"""
    if n < 2:
        return False
    for i in range(2, int(n ** 0.5) + 1):
        if n % i == 0:
            return False
    return True


# 模块级别的"私有"函数：_ 前缀表示不希望被外部使用
def _helper():
    pass


if __name__ == "__main__":
    print(f"add(3, 4) = {add(3, 4)}")
    print(f"factorial(5) = {factorial(5)}")
    print(f"is_prime(17) = {is_prime(17)}")
