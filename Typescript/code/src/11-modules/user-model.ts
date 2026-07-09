/**
 * user-model.ts —— 第 11 课的「被导入」模块之二
 * ------------------------------------------------------------
 * 演示「默认导出」（default export）：一个文件最多只能有一个 default 导出。
 * 默认导出在 import 时可以任意命名。
 */

// 一个接口，用「命名导出」方式导出
export interface IUser {
  id: number;
  name: string;
}

// 一个类，作为这个模块的「默认导出」
export default class UserModel implements IUser {
  constructor(
    public id: number,
    public name: string,
  ) {}

  describe(): string {
    return `User#${this.id} ${this.name}`;
  }
}
