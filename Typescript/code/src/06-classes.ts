/**
 * ============================================================
 * 第 06 课：类（Classes）
 * ============================================================
 * 本节学什么：
 *   1. 类的定义、字段、构造函数
 *   2. 访问修饰符 public / private / protected / readonly
 *   3. 参数属性（构造函数里的简写）
 *   4. getter / setter
 *   5. static 静态成员
 *   6. 继承 extends 与 super
 *   7. abstract 抽象类
 *   8. implements 实现接口
 *   9. # 私有字段（JS 原生私有，运行时真正私有）
 *
 * 运行：  npx tsx src/06-classes.ts
 *
 * 给会其他语言的你：TS 的类和 Java/C# 很像，但底层是 JS 原型。
 *   private/protected 是「编译期」检查；#x 是「运行时」真正私有。
 */

// ------------------------------------------------------------
// 1 & 2 & 3. 字段、构造函数、访问修饰符、参数属性
// ------------------------------------------------------------
class Account {
  // 显式声明字段（也可以不写类型，由构造函数赋值推断）
  public owner: string; // public：默认，外部可访问
  private balance: number; // private：仅类内部可访问
  protected readonly id: number; // protected：本类和子类可访问；readonly：只读

  constructor(owner: string, initial: number) {
    this.owner = owner;
    this.balance = initial;
    this.id = Math.floor(Math.random() * 1000);
  }

  deposit(amount: number): void {
    this.balance += amount;
  }

  // getter：像访问属性一样调用方法（account.info 而不是 account.info()）
  get info(): string {
    return `${this.owner} 余额: ${this.balance}`;
  }

  // setter：赋值时触发，可在其中做校验
  set deposit2(amount: number) {
    if (amount > 0) this.balance += amount;
  }
}

// 「参数属性」简写：在构造函数参数前加修饰符，TS 会自动声明同名字段并赋值。
// 下面这个类和上面手写字段的效果一样，但代码少很多。
class Point {
  constructor(
    public x: number, // 等价于：声明 public x，并 this.x = x
    public y: number,
  ) {}
  distanceToOrigin(): number {
    return Math.sqrt(this.x ** 2 + this.y ** 2);
  }
}

// ------------------------------------------------------------
// 5. static 静态成员（属于「类」本身，不属于实例）
// ------------------------------------------------------------
class MathHelper {
  static readonly PI = 3.14159; // 静态属性
  static circleArea(r: number): number {
    // 静态方法
    return MathHelper.PI * r * r;
  }
}

// ------------------------------------------------------------
// 7. abstract 抽象类（不能被直接实例化，作为基类规定「子类必须实现什么」）
// ------------------------------------------------------------
abstract class Shape {
  abstract area(): number; // 抽象方法：只有签名，子类必须实现
  // 抽象类里也可以有普通的已实现方法
  describe(): string {
    return `这个图形面积是 ${this.area()}`;
  }
}

// ------------------------------------------------------------
// 8. implements 实现接口
// ------------------------------------------------------------
interface Printable {
  print(): void;
}

// ------------------------------------------------------------
// 6. 继承 extends + super，同时实现接口
// ------------------------------------------------------------
class Circle extends Shape implements Printable {
  // 9. # 私有字段：JS 原生语法，运行时真正私有（外部连访问都做不到）
  #secret = 'circle-secret';

  constructor(public radius: number) {
    super(); // 子类构造函数必须先调用 super() 初始化父类
  }

  // 实现父类的抽象方法
  area(): number {
    return Math.PI * this.radius ** 2;
  }

  // 实现接口要求的方法
  print(): void {
    console.log(this.describe(), '| #secret =', this.#secret);
  }
}

console.log('=== 第 06 课：类 ===');
const acc = new Account('Alice', 100);
acc.deposit(50);
console.log(acc.info); // getter，无括号
// acc.balance;        // ❌ private，外部不可访问

const p = new Point(3, 4);
console.log('Point 到原点距离 =', p.distanceToOrigin());

console.log('圆面积(r=2) =', MathHelper.circleArea(2)); // 直接用类名调用静态方法

const c = new Circle(5);
c.print();
// new Shape();        // ❌ 抽象类不能实例化

// 让本文件成为独立模块：每个 .ts 文件都有独立作用域，避免与其它课程文件的同名声明在全局冲突。
export {};
