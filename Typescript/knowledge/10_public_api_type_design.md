# 10 · 公共 API 的类型设计与演进 ⭐⭐⭐

> 好的 API 类型不仅阻止错误，还会引导调用方写出正确代码，并在业务变化时把修改点准确暴露出来。

---

## 1. 公共签名优先表达关系

弱类型签名只罗列可能性：

```typescript
function get(obj: object, key: string): unknown;
```

强类型签名保留输入间的关系：

```typescript
function get<T, K extends keyof T>(obj: T, key: K): T[K] {
    return obj[key];
}
```

设计公共 API 时依次问：

1. 哪些参数彼此相关？
2. 返回类型依赖哪个参数？
3. 哪些非法组合可以在签名层排除？
4. 哪些规则只能运行时验证？

不要把“所有可能值的联合”误当成精确设计；相关性才是类型信息的核心资产。

---

## 2. 联合参数通常优于大量重载

如果不同输入返回相同类型：

```typescript
function len(value: string): number;
function len(value: readonly unknown[]): number;
```

调用方手里是 `string | unknown[]` 时，重载解析可能无法选中单一签名。直接写联合更符合实现：

```typescript
function len(value: string | readonly unknown[]): number {
    return value.length;
}
```

当返回类型确实随输入形态变化时才使用重载或泛型映射：

```typescript
function parse(value: string): object;
function parse(value: Uint8Array): object;
function parse(value: string | Uint8Array): object {
    // implementation
    return {};
}
```

实现签名对调用方不可见；每个公开重载都必须被实现签名兼容。

---

## 3. Options 对象适合可演进参数

```typescript
function request(
    url: string,
    options?: {
        timeoutMs?: number;
        signal?: AbortSignal;
        retries?: number;
    },
): Promise<Response>;
```

相比多个位置参数，options 对象具备：

- 调用处自解释。
- 新增可选字段通常不破坏旧调用方。
- 可通过 `satisfies` 校验配置表。
- 更容易区分“缺失”和“显式值”。

不要随意把 options 改为必填，或把可选字段改为必填；这都是破坏性变更。

---

## 4. 返回只读视图，避免泄漏内部可变性

```typescript
class Registry<T> {
    #items: T[] = [];

    list(): readonly T[] {
        return this.#items;
    }
}
```

但 `readonly` 只限制类型层面的写操作，且通常是浅层的。若内部状态不能被外界对象引用修改，需要复制或深层不可变结构：

```typescript
list(): readonly T[] {
    return [...this.#items];
}
```

复制有运行时成本。API 契约应明确“只读视图”“快照”还是“活集合”，不要把三者混为一谈。

---

## 5. 接收宽类型，返回精确类型

只读取输入集合的函数应接收 `readonly`：

```typescript
function unique<T>(values: readonly T[]): T[] {
    return [...new Set(values)];
}
```

调用者可以传可变数组、只读数组或 `as const` 元组。若参数写成 `T[]`，就无谓拒绝了只读值。

返回类型则应表达真正保证，不要用 `any` 或过宽联合“方便实现”。一个实用原则是：**参数类型允许所有实现能安全处理的值；返回类型只承诺实现一定提供的能力。**

---

## 6. Builder API 要保存状态，还是运行时校验？

可以用类型参数记录构建阶段：

```typescript
type Missing = { readonly state: "missing" };
type Present = { readonly state: "present" };

class RequestBuilder<HasUrl = Missing> {
    private url?: string;

    withUrl(url: string): RequestBuilder<Present> {
        this.url = url;
        return this as unknown as RequestBuilder<Present>;
    }

    build(this: RequestBuilder<Present>) {
        return { url: this.url! };
    }
}
```

这种 typestate 能让缺少必填步骤的调用无法编译，但会增加声明复杂度、断言和错误信息长度。适合步骤少、状态稳定、错误代价高的 API；普通配置对象加运行时校验往往更清楚。

类型复杂度必须由实际收益支付，不能只追求“零运行时检查”。

---

## 7. 事件 API 应由映射表驱动

```typescript
type Events = {
    ready: void;
    data: { bytes: Uint8Array };
    error: { cause: unknown; retryable: boolean };
};

interface Emitter<E extends Record<PropertyKey, unknown>> {
    on<K extends keyof E>(name: K, handler: (payload: E[K]) => void): () => void;
    emit<K extends keyof E>(name: K, payload: E[K]): void;
}
```

映射表把事件名与载荷的对应关系集中为单一事实来源。注意 `void` 事件在通用 `emit` 签名中仍可能要求第二个参数；若调用体验需要 `emit("ready")`，可通过条件元组表达参数列表：

```typescript
type EmitArgs<T> = [T] extends [void] ? [] : [payload: T];

interface BetterEmitter<E extends Record<PropertyKey, unknown>> {
    emit<K extends keyof E>(name: K, ...args: EmitArgs<E[K]>): void;
}
```

`[T]` 包裹用于避免条件类型对联合分发。

---

## 8. 名称、错误位置和可读性也是类型设计

```typescript
type Normalize<T, U, V> = /* ... */;
```

即使能工作，也可能让调用方看到无法理解的 20 层条件类型。改善方式：

- 给中间概念命名，而不是把所有运算写在一个类型中。
- 在公共签名使用领域词汇，如 `EventPayload<E, K>`。
- 把约束放到最接近错误来源的位置。
- 用对象参数让报错指向具体字段。
- 导出用户需要引用的类型，不泄漏纯内部辅助类型。

类型错误是 API 的用户界面。精确但不可读的错误会迫使调用方使用 `as any`，最终抵消类型价值。

---

## 9. 不要让条件类型意外分发

```typescript
type Jsonify<T> = T extends Date
    ? string
    : T extends readonly (infer U)[]
        ? Jsonify<U>[]
        : T extends object
            ? { [K in keyof T]: Jsonify<T[K]> }
            : T;
```

递归条件类型可用于描述转换，但要明确边界：

- 函数、Map、Set、品牌类型该如何处理？
- 可选与 readonly 修饰符是否保留？
- 联合分发是不是期望行为？
- 递归深度和编辑器性能是否可接受？

不要宣称类型完全模拟 `JSON.stringify`，除非真的覆盖了其运行时细节。名称和文档必须与实际保证一致。

---

## 10. 类型层面的破坏性变更

以下变化即使运行时代码兼容，也可能破坏消费者编译：

- 收窄参数类型或新增必填参数。
- 扩宽返回类型，例如从 `User` 变成 `User | undefined`。
- 给公共联合新增成员，导致消费者穷尽检查失败。
- 改变泛型默认值或约束。
- 把属性从可变改为只读，或反过来影响赋值关系。
- 改变导出的类型别名结构，使条件类型结果变化。
- 改变包的模块入口或声明格式。

给可辨识联合新增成员在生产者看来是扩展，在做穷尽匹配的消费者看来是破坏性变化。发布策略必须从消费者源码视角判断。

---

## 11. 防止推断结果成为意外契约

```typescript
export function loadConfig() {
    return {
        cache: new Map<string, string>(),
        internalRetryCount: 3,
    };
}
```

若生成声明，所有推断成员可能成为消费者依赖的契约。显式公共返回类型可以隐藏实现细节：

```typescript
export interface ConfigView {
    readonly cacheEnabled: boolean;
}

export function loadConfig(): ConfigView {
    return { cacheEnabled: true };
}
```

显式返回类型还有助于在实现处发现不兼容，而不是让声明快照静默漂移。

---

## 12. 类型 API 的验证方式

普通单元测试只验证运行时。公共类型还需要编译期契约测试，至少覆盖：

- 应该通过的典型调用。
- 应该失败的调用，并用 `@ts-expect-error` 确认错误确实存在。
- 字面量和泛型推断是否保持精确。
- `.d.ts` 产物是否只暴露预期类型。
- 支持的最低 TS 版本能否消费声明。
- ESM/CJS 或不同 `moduleResolution` 消费场景。

`@ts-expect-error` 优于 `@ts-ignore`：如果未来该行不再报错，前者会主动失败，提醒你检查契约变化。

---

## 13. 设计检查清单

- 泛型参数是否表达真实关系，而非仅替代 `any`？
- 输入之间的相关性是否被保存？
- 只读输入是否接受 `readonly`？
- 返回值是否隐藏内部可变实现？
- 重载是否真的需要不同返回关系？
- 错误信息对调用方是否可理解？
- 新增联合成员会如何影响穷尽检查？
- 公共导出是否有稳定、可命名的返回类型？
- 正向和负向的编译期用例是否都测试？

---

## 一句话总结

公共类型是产品接口，不是实现的副产物。它应保存参数关系、限制非法组合、隐藏内部细节，并像运行时代码一样接受兼容性设计与自动化测试。

