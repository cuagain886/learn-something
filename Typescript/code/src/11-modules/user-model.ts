/**
 * 默认导出不是“匿名的特殊模块系统”：它仍然是 ESM 的一个导出槽位，
 * 只是导入方可以自行选择本地绑定名。
 *
 * interface 只创建类型；class 同时创建实例类型和运行时构造器值。
 */

// UserView：一个纯类型契约，描述外部观察者可见的最小形状（id + name）。
// emit 后整个 interface 消失，运行时不留任何字段或方法。
export interface UserView {
  readonly id: number;
  readonly name: string;
}

// export default class：把同一个 class 同时塞进两个导出槽——
//   (1) default 槽：导入方可以任意改名，如 `import Foo from './user-model.js'`；
//   (2) 名为 UserModel 的命名槽：可以用 `import { UserModel } from ...` 取到。
// implements UserView 只在编译期做形状校验，不产生运行时影响；
// class 自身既是“实例类型”（可用于类型标注）又是“构造器值”（可用于 new / instanceof）。
export default class UserModel implements UserView {
  // constructor 参数属性：参数前加 `public readonly` 修饰符，
  // TypeScript 会自动声明并赋值同名字段，等价于在类体里手写 `readonly id: number` 再 `this.id = id`。
  constructor(
    public readonly id: number,
    public readonly name: string,
  ) {}

  // 静态工厂方法：从一个已有 UserView 形状的数据构造 UserModel 实例。
  // 静态成员挂在类（构造器）上而不是实例上，调用方式是 `UserModel.from(...)`。
  static from(view: UserView): UserModel {
    return new UserModel(view.id, view.name);
  }

  // 实例方法：返回可读的标识字符串，便于在日志/断言里识别实例。
  describe(): string {
    return `User#${this.id} ${this.name}`;
  }

  // 把实例投影回纯数据形状 UserView，常用于序列化或跨模块边界传输（去方法、只留数据）。
  toJSON(): UserView {
    return { id: this.id, name: this.name };
  }
}
