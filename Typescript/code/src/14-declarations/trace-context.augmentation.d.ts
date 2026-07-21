/**
 * 这是 module augmentation，不是创建一个新的 ambient module。
 * 顶层 import 先让本文件成为模块，也确保目标模块进入程序。
 */
// ---------------------------------------------------------------------------
// .d.ts 与 .ts 的根本区别：声明文件没有运行时实现
// ---------------------------------------------------------------------------
// 本文件整体只参与 checker，运行时不会被执行任何一行：
//   - 没有可执行的语句（只有 import、declare module 块）；
//   - emit 阶段不会为它生成对应的 .js（tsc 看到 .d.ts 默认跳过）；
//   - 因此 augmentation 引入的类型信息只在编译期可见，运行时彻底消失。
// 它存在的唯一目的：在 checker 看到的“类型环境”里，往已有模块的形状上添加成员。

// 顶层 import 看起来像“无意义的副作用导入”，实际上有两个必备作用：
//   1. 让本文件从“全局脚本”变成“模块”。只有模块文件才能写 `declare module '...'`
//      这种扩充语法；纯脚本文件里的 declare module 会被当成新建 ambient module，
//      而不是合并到已存在的模块上。
//   2. 把被扩充的目标模块 './trace-context.js' 引入编译范围，
//      否则 augmentation 没有可合并的目标，会变成“悬空扩充”而不生效。
// 配合 tsconfig 的 rewriteRelativeImportExtensions，写 .js 后缀在源码与 dist 都正确。
import './trace-context.js';

// `declare module '...'` 是 module augmentation 的关键语法：
//   - 字符串字面量必须与被扩充模块的“规范名”一致（这里就是相对导入路径 './trace-context.js'）；
//   - 花括号里声明的 interface 会与目标模块里同名 interface 做 declaration merging，
//     而不是新建一个同名的、互不相干的接口；
//   - 它不创建新的运行时模块，也不会改变 JS 端的导出 —— 只是扩充 checker 看到的类型。
declare module './trace-context.js' {
  // 这里的 TraceContext 与 trace-context.ts 里的 export interface TraceContext 同名，
  // 因此合并后，原本只有 runId 的接口就多出了 readonly tenantId?: string。
  // 合并规则：同名字段会冲突报错，不同字段则累加；这里新增了一个原本不存在的字段。
  interface TraceContext {
    // tenantId 标记为可选（?）有两个原因：
    //   1. 实现 describeTrace 时希望“有就用，没有就降级”，可选让类型与运行时一致；
    //   2. 已有调用点都只构造了 runId，如果改成必填，会一次性破坏所有旧代码。
    // readonly 与原始 runId 的修饰风格保持一致，强调它是一个不可变的描述字段。
    readonly tenantId?: string;
  }
}
