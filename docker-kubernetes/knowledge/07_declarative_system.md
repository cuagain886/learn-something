# 声明式系统：对象、版本、字段所有权与收敛

声明式并不是“用 YAML 代替命令”。它的关键是提交可比较的期望状态，让系统持续观察、计算差异并收敛。YAML 只是序列化格式；真正的协议是 Kubernetes API。

## 1. 对象的四类信息

一个持久对象通常包含：

- `apiVersion` 与 `kind`：使用哪个 API schema；
- `metadata`：名字、命名空间、UID、版本、标签、所有者等身份与并发信息；
- `spec`：调用者希望系统达到的状态；
- `status`：系统观察到的状态，由组件回写。

不要把 spec/status 当作绝对规则：不同资源的 schema 才是最终契约。但对 Deployment 等典型资源，“用户写 spec、控制器写 status”是理解责任边界的有效模型。

## 2. GVK、GVR 与资源身份

`apps/v1, Kind=Deployment` 是 Group-Version-Kind；REST 路径使用复数 resource，例如：

```text
/apis/apps/v1/namespaces/dk-course/deployments/api-demo
```

这是 Group-Version-Resource。kind 常用于对象编码和类型识别，resource 用于 REST 集合操作。名称只在资源类型和命名空间范围内唯一；UID 才能区分“删掉后用同名重建”的两个对象。

因此监控系统若只用 namespace/name 关联历史，可能把新旧实例误认为同一个生命体。

## 3. 一个写请求经过什么

概念上，请求会经历：

1. 解码与 API 版本转换；
2. 认证：你是谁；
3. 授权：你能否对该资源执行该 verb；
4. mutating admission：按策略修改对象；
5. 默认值与 schema 校验；
6. validating admission：接受或拒绝；
7. 持久化并向 watch 客户端传播变化。

具体内部次序会受版本和实现影响，排障时不要依靠一个过度简化的固定流水线。稳定的外部结论是：客户端本地 YAML 合法不等于服务器接受；服务器返回的 live object 才包含默认值、准入变更与版本元数据。

## 4. create、replace、patch、apply 不等价

- create：对象必须不存在；提交初始状态。
- replace/update：通常发送完整对象，并以 `resourceVersion` 做并发控制。
- JSON Merge Patch：对象字段合并，`null` 常有删除语义；数组通常整体替换。
- JSON Patch：显式 add/remove/replace 路径操作。
- Strategic Merge Patch：对内建 Kubernetes 类型利用 patch strategy/merge key；并非所有 CRD 都有相同语义。
- Server-Side Apply（SSA）：服务器按 schema 合并声明，并追踪字段所有权。

“patch 一下”不是足够精确的设计描述，必须说明 patch 类型及列表语义。

## 5. Server-Side Apply 的字段所有权

SSA 把“哪个 manager 声明了哪些字段”记录在 `metadata.managedFields`。若 manager A 已拥有某字段，manager B 提交不同值，服务器会报告 conflict。B 有三种合理选择：

1. 不再声明该字段，把所有权留给 A；
2. 与 A 协调，由 A 修改；
3. 明确使用 force conflicts，接管所有权。

强制接管不是“更可靠的 apply”，而是一次治理决定。自动化系统若都无条件 force，会彼此夺权，表面收敛、实际抖动。

字段所有权是结构化字段集，不等于整个对象归某一个人。两个 manager 可以分别拥有 `spec.replicas` 和容器镜像；相同字段提交相同值时也可能共享所有权。

## 6. 省略字段是否等于删除

答案取决于写入方法和所有权：

- SSA manager 曾拥有字段，后来从自己的 apply 配置中省略，通常表示它放弃该字段；若没有其他 manager 拥有，字段可能被删除或恢复默认。
- 普通 merge patch 中未出现的字段通常保持不变。
- replace 发送完整对象，遗漏字段可能消失或被默认。

这正是“把 kubectl 命令背下来”不够的原因：必须理解服务器合并语义。

## 7. generation、observedGeneration 与 resourceVersion

- `metadata.generation` 通常在期望状态发生有意义变化时递增。
- 控制器可在 status 写 `observedGeneration`，表示它处理到了哪一代 spec。
- `metadata.resourceVersion` 每次存储变更都可能变化，包括 status 更新。

若 `observedGeneration < generation`，即使旧的 Ready condition 看起来正常，也不能断言新配置已经生效。部署系统等待 rollout 时应同时理解 generation 与 conditions，而不是只 sleep 固定秒数。

## 8. 乐观并发而非最后写入永远赢

读取对象后再 update，客户端带回 resourceVersion。若期间对象已改变，服务器返回 conflict，避免用旧快照覆盖新值。正确的 read-modify-write 循环是：

```text
GET 最新对象 → 重新计算变更 → UPDATE → 冲突则重试
```

重试必须重算，不能原样重复旧 payload。对跨多个对象的不变量，Kubernetes API 通常不提供通用多对象事务，需要控制器设计补偿和最终一致性。

## 9. 标签、注解、ownerReferences 与 finalizers

- label 是可索引的选择维度，适合 selector；不要放高基数、超长或敏感数据。
- annotation 保存非标识元数据，通常不用于 selector。
- ownerReferences 表示依赖所有权，驱动垃圾回收；跨命名空间所有权受严格限制。
- finalizer 是删除前必须完成的清理键。设置 `deletionTimestamp` 后，对象处于终止流程；负责方完成外部清理再移除 finalizer。

finalizer 不是“阻止删除的权限锁”。控制器失效会让对象卡在 Terminating，因此必须让清理逻辑幂等并可观测，且准备受控的人工恢复程序。

## 10. 声明式不保证什么

它不自动保证：

- 每次变更无中断；需要资源控制器的 rollout 策略和健康门槛。
- 多对象原子更新；需要编排、补偿或更高层 controller。
- 配置语义正确；schema 只能发现结构错误，无法判断错误的业务阈值。
- 外部系统同步；云资源、DNS、数据库迁移需要各自控制器和失败恢复。

## 11. 可验证的操作习惯

1. 提交前使用 schema 校验和 server-side dry-run；后者才能包含服务器默认值与 admission。
2. 用 `kubectl diff --server-side` 预览 live state 与期望的差异。
3. 给自动化指定稳定、唯一的 field manager 名。
4. apply 后读取 live object、managedFields、generation 和 conditions。
5. 发生 conflict 时先识别字段拥有者，再决定移除声明、协调或强制接管。

实验入口：[12 声明式 API](../code/12_declarative_api/README.md)。
