# 生成进度追踪

> 供 /loop 迭代使用的构建状态。全部完成后本文件可删除。
> 规格来源：goal.md。质量标准：每章 14 节结构、细致不泛泛、代码可运行、⚠️ 标坑。

## 状态

| 产物 | 状态 | 说明 |
|------|------|------|
| README.md | ✅ 迭代1 | |
| knowledge/00_learning_map.md | ✅ 迭代1 | |
| knowledge/01_network_foundations.md | ✅ 迭代1 | 14 节全结构 |
| knowledge/02_link_layer_and_lan.md | ⬜ | P2，可短（~400行） |
| knowledge/03_ip_routing_nat.md | ⬜ | P1 |
| knowledge/04_udp.md | ⬜ | P1，可短 |
| knowledge/05_tcp_connection.md | ⬜ | P0 重点，要最细 |
| knowledge/06_tcp_reliability_congestion.md | ⬜ | P0 重点 |
| knowledge/07_socket_programming_io.md | ⬜ | P0 重点 |
| knowledge/08_dns_service_discovery.md | ⬜ | P1 |
| knowledge/09_http1.md | ⬜ | P0 重点 |
| knowledge/10_tls_https.md | ⬜ | P0 |
| knowledge/11_http2_http3_quic.md | ⬜ | P0 |
| knowledge/12_realtime_streaming.md | ⬜ | P0，Agent 重点 |
| knowledge/13_proxy_lb_gateway.md | ⬜ | P1 |
| knowledge/14_container_cloud_network.md | ⬜ | P1 |
| knowledge/15_network_security.md | ⬜ | P1 |
| knowledge/16_performance_tuning.md | ⬜ | P1 |
| knowledge/17_observability_debugging.md | ⬜ | P0，含排查决策树 |
| knowledge/18_interview_questions.md | ⬜ | 汇总，最后写 |
| knowledge/19_twelve_week_plan.md | ⬜ | 12 周计划 |
| code/README.md | ✅ 迭代1 | 状态列需随代码生成更新 |
| code/01_tcp_echo ~ 12_agent_gateway | ⬜ ×12 | 与对应章节同迭代或紧随生成 |
| labs/lab_01 ~ lab_08 | ⬜ ×8 | 与对应章节同迭代生成 |

## 生成顺序计划（每迭代 1-2 个知识章 + 配套 code/lab）

1. ~~迭代1：骨架 + 01 章~~ ✅
2. 迭代2：05 TCP 连接（最重章）+ code/03_tcp_states + lab_01 + lab_03
3. 迭代3：06 TCP 传输 + 07 Socket 编程开头；或 07 全章 + code/01、02 + lab_02
4. 迭代4：09 HTTP/1.1 + code/04、05 + lab_04
5. 迭代5：10 TLS + code/08 + lab_05；02/03/04 支线章（较短，可并一迭代）
6. 迭代6：11 HTTP/2/3 + 08 DNS + code/09 + lab_06
7. 迭代7：12 流式通信 + code/06、07 + lab_07
8. 迭代8：13 代理 + 17 排障（决策树）+ code/10
9. 迭代9：14 容器网络 + 15 安全 + code/11
10. 迭代10：16 性能 + lab_08 + 18 面试题
11. 迭代11：19 十二周计划 + code/12_agent_gateway（阶段1-4）
12. 迭代12+：agent_gateway 后续阶段 + 全局一致性检查（交叉引用、code README 状态列、goal.md 执行方式第 8 条自查）

## 质量自查（每章生成后过一遍）

- [ ] 14 节结构齐全（目标/概念/原理/报文/图解/Go示例/后端应用/Agent应用/错误设计/排障/实验/面试题/总结+检查清单/延伸阅读）
- [ ] 每个核心概念至少一个具体场景；协议章有抓包验证方法
- [ ] Go 代码有超时/取消/资源关闭，非玩具代码
- [ ] ⚠️ 标注陷阱；术语首现带英文；关键行为标 RFC
- [ ] 区分协议标准 / Linux 实现 / Go 实现三个层面
- [ ] 与 Nginx/RPC/MQ/os 目录只互补不重复
