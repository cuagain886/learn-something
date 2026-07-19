/**
 * 默认导出不是“匿名的特殊模块系统”：它仍然是 ESM 的一个导出槽位，
 * 只是导入方可以自行选择本地绑定名。
 *
 * interface 只创建类型；class 同时创建实例类型和运行时构造器值。
 */

export interface UserView {
  readonly id: number;
  readonly name: string;
}

export default class UserModel implements UserView {
  constructor(
    public readonly id: number,
    public readonly name: string,
  ) {}

  static from(view: UserView): UserModel {
    return new UserModel(view.id, view.name);
  }

  describe(): string {
    return `User#${this.id} ${this.name}`;
  }

  toJSON(): UserView {
    return { id: this.id, name: this.name };
  }
}
