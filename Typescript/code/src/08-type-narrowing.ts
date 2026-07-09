/**
 * ============================================================
 * 第 08 课：类型收窄与类型守卫（Narrowing & Type Guards）
 * ============================================================
 * 本节学什么：
 *   1. typeof 守卫
 *   2. instanceof 守卫
 *   3. in 操作符守卫
 *   4. 真值收窄 / 相等收窄
 *   5. 自定义类型谓词（value is Type）
 *   6. 可辨识联合（Discriminated Union）—— 实战重点
 *   7. 穷尽检查（用 never 保证「所有情况都处理了」）
 *
 * 运行：  npx tsx src/08-type-narrowing.ts
 *
 * 核心思想：联合类型的值，要先「收窄」到具体类型，TS 才允许你安全地使用它。
 *   收窄就是在某段代码里，让 TS 确信「此刻这个值一定是某个更具体的类型」。
 */

// ------------------------------------------------------------
// 1. typeof 守卫（判断原始类型）
// ------------------------------------------------------------
function formatValue(value: string | number): string {
  if (typeof value === 'string') {
    // 这个分支里 value 被收窄为 string
    return value.trim().toUpperCase();
  }
  // 走到这里 value 一定是 number
  return value.toFixed(2);
}

// ------------------------------------------------------------
// 2. instanceof 守卫（判断是不是某个类的实例）
// ------------------------------------------------------------
class Cat {
  meow() {
    return 'Meow';
  }
}
class Dog {
  bark() {
    return 'Woof';
  }
}
function speak(animal: Cat | Dog): string {
  if (animal instanceof Cat) {
    return animal.meow(); // 收窄为 Cat
  }
  return animal.bark(); // 收窄为 Dog
}

// ------------------------------------------------------------
// 3. in 操作符守卫（判断对象是否含某个属性）
// ------------------------------------------------------------
type Fish = { swim: () => string };
type Bird = { fly: () => string };
function move(pet: Fish | Bird): string {
  if ('swim' in pet) {
    return pet.swim(); // 有 swim → 收窄为 Fish
  }
  return pet.fly(); // 否则收窄为 Bird
}

// ------------------------------------------------------------
// 4. 真值收窄 / 相等收窄
// ------------------------------------------------------------
function printName(name: string | null | undefined): string {
  // 真值收窄：if (name) 排除了 null、undefined、空字符串
  if (name) {
    return name.toUpperCase();
  }
  return '(无名)';
}

// ------------------------------------------------------------
// 5. 自定义类型谓词（Type Predicate）：返回值写成 `参数 is 类型`
// ------------------------------------------------------------
// 把一段「判断逻辑」封装成函数，并告诉 TS：返回 true 时入参就是某类型。
function isFish(pet: Fish | Bird): pet is Fish {
  return (pet as Fish).swim !== undefined;
}
function handlePet(pet: Fish | Bird) {
  if (isFish(pet)) {
    // 因为 isFish 的返回类型是 `pet is Fish`，这里 pet 被收窄为 Fish
    return pet.swim();
  }
  return pet.fly();
}

// ------------------------------------------------------------
// 6. 可辨识联合（Discriminated Union）—— 强烈推荐的建模方式
// ------------------------------------------------------------
// 给联合的每个成员加一个共同的「字面量标签字段」（这里是 kind），
// TS 就能根据这个标签自动收窄到对应成员。
interface CircleShape {
  kind: 'circle'; // 标签
  radius: number;
}
interface RectShape {
  kind: 'rect';
  width: number;
  height: number;
}
interface TriangleShape {
  kind: 'triangle';
  base: number;
  height: number;
}
type AnyShape = CircleShape | RectShape | TriangleShape;

function area(shape: AnyShape): number {
  switch (shape.kind) {
    case 'circle':
      return Math.PI * shape.radius ** 2; // 这里 shape 一定是 CircleShape
    case 'rect':
      return shape.width * shape.height; // RectShape
    case 'triangle':
      return (shape.base * shape.height) / 2; // TriangleShape
    default:
      // 7. 穷尽检查：如果上面漏处理了某个成员，shape 在这里就不是 never，
      //    下面这行赋值会编译报错，从而强制你「补齐所有分支」。
      const _exhaustive: never = shape;
      return _exhaustive;
  }
}

console.log('=== 第 08 课：类型收窄 ===');
console.log(formatValue('  hello  '), '|', formatValue(3.14159));
console.log(speak(new Cat()), '|', speak(new Dog()));
console.log(move({ swim: () => '游泳' }), '|', move({ fly: () => '飞翔' }));
console.log(printName('alice'), '|', printName(null));
console.log(handlePet({ swim: () => '🐟 游' }));
console.log('circle area =', area({ kind: 'circle', radius: 2 }));
console.log('rect area =', area({ kind: 'rect', width: 3, height: 4 }));
console.log('triangle area =', area({ kind: 'triangle', base: 6, height: 2 }));

// 让本文件成为独立模块：每个 .ts 文件都有独立作用域，避免与其它课程文件的同名声明在全局冲突。
export {};
