# TLS 握手、证书、会话复用与安全

## 1. TLS 在 HTTP 之前

```text
TCP accept -> TLS ClientHello/SNI/ALPN -> certificate/key exchange
-> handshake complete -> encrypted HTTP request -> Host/location
```

证书选择不能依赖尚未解密的 HTTP Host，只能依赖 listen/default SSL server 和 SNI。

## 2. SNI 与 ALPN

SNI 表示客户端期望的服务器名，Nginx用它选择 virtual server/certificate。

ALPN 协商 `h2` 或 `http/1.1`；HTTP/3 走 QUIC/UDP 和不同监听路径。

老客户端无 SNI 时只能得到 default server 证书。

## 3. TLS1.2 与 TLS1.3

TLS1.3 简化握手并移除许多旧算法，cipher 配置方式也与 TLS1.2 不同。

不能只复制多年以前的 `ssl_ciphers` 模板并认为覆盖 TLS1.3。

以当前 OpenSSL、Nginx 和安全基线验证，避免启用已淘汰协议。

## 4. 证书链

服务端证书文件应包含 leaf 后按顺序附带中间证书，通常不发送 root。

链不完整时浏览器可能因本地缓存看似正常，而干净客户端失败。

用 `openssl s_client -showcerts` 和独立 TLS scanner 验证。

私钥权限应仅允许 master 必要读取，避免进入镜像、日志或配置仓库。

## 5. session cache

完整握手 CPU 成本高。

共享 session cache 允许 worker 间复用 TLS session；内置 OpenSSL cache 常是 per worker，并可能产生碎片。

官方文档给出共享 cache 每 MB 可容纳会话的近似值，但应以协议、库版本和流量实测。

## 6. session ticket

ticket 把加密会话状态交给客户端保存。

多节点需共享/轮换 ticket key，否则跨节点复用失败。

ticket key 长期不轮换会扩大密钥泄露影响；频繁不协调轮换又降低复用率。

## 7. OCSP stapling

Nginx 可向 CA responder 获取证书状态并 stapling 给客户端，减少客户端单独查询。

需要正确 issuer/trusted certificate、resolver、网络与时间。

stapling 失败通常不应被误认为证书本身必然失效，但要监控续期和响应。

## 8. 0-RTT

TLS1.3 early data 可降低恢复连接延迟，但具有重放风险。

不能让非幂等支付/创建操作无条件接受 early data。

必须在应用/网关限制方法和业务幂等。

## 9. mTLS

`ssl_verify_client` 验证客户端证书。

还要处理：

- 信任链和 CRL/OCSP。
- subject/SAN 到身份映射。
- 证书轮换重叠窗口。
- 把验证结果安全传给 upstream，防止客户端伪造 header。

## 10. 握手性能

CPU 成本主要来自非对称握手、证书链和加密。

优化：keepalive、HTTP/2 多路复用、session reuse、合理 worker 和硬件能力。

不要为省 CPU 禁用证书验证或启用弱算法。

## 11. 超时与攻击

TLS handshake 占 connection、内存和 CPU。

慢握手/连接洪水需要 handshake timeout、连接限制、内核队列和上游 DDoS 防护。

单靠 Nginx 事件驱动不能抵御带宽耗尽。

## 12. 证书 reload

证书文件更新后需要 reload 让新 worker 加载。

旧 worker/旧连接继续使用原 TLS context，直到排空。

部署流程：写新文件原子替换 → 校验证书/私钥匹配与有效期 → nginx -t → reload → 新连接验证 → 保留回滚。

## 13. 日志与调试

记录协议/cipher、SNI、session reused 等变量时注意隐私和基数。

使用：

```bash
openssl s_client -connect host:443 -servername example.com -alpn h2
```

验证证书链、ALPN 和复用。

## 14. 面试追问

问：为什么两个 HTTPS server 共端口时证书可能选错？

答：证书在 HTTP Host 到达前由 SNI/default server 选择；无 SNI 或 listen 配置不一致会落默认 SSL context。

