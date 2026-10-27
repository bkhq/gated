# TLS 与内置 CA

[English](tls-and-ca.md) | 简体中文

两个 crate 负责 X.509 相关事务：`gated-tls`（所有监听器和出站连接共享的 rustls 管线）和 `gated-ca`（为 mTLS
持有证明签发客户端证书的最小化证书颁发机构）。

## `gated-tls`

- **加载**：`TlsCertificateBundle` 和 `TlsPrivateKey`（`crates/gated-tls/src/cert.rs`）从文件加载 PEM 证书链 /
  密钥并转换为 rustls `CertifiedKey`；证书包可以为多证书监听器枚举其 SNI 名称。
- **`TlsMode`**（`crates/gated-tls/src/mode.rs`）：`Disabled` / `Preferred`（默认）/ `Required` —— 数据库目标
  的出站连接使用。
- **`MaybeTlsStream`**（`crates/gated-tls/src/maybe_tls_stream.rs`）：原始流和 TLS 流的枚举，支持就地升级，供
  在握手中途协商 TLS 的 MySQL/PostgreSQL 代理使用。
- **出站验证**：`configure_tls_connector`（`crates/gated-tls/src/rustls_helpers.rs`）构建客户端配置，有三个验证
  级别 —— 基于系统根证书的完整 WebPKI（可附加额外根证书）、校验证书链但忽略主机名、全部接受 —— 由目标的
  `tls.verify` 及相关标志选择。
- 代码库中没有任何地方使用 ALPN。

### 监听器证书

每个监听器从各自的配置段（`admin`、`http`、`mysql`、`postgres`）加载证书 / 密钥。`gated setup` 通过 `rcgen`
生成一份自签名证书（SAN 为 `gated.local`、`localhost`），位于 `<data>/tls.certificate.pem` / `tls.key.pem`，
并让四个配置段都指向它（`crates/gated/src/commands/setup.rs`）；生产部署应把这些路径换成真实证书。管理 HTTP
监听器还支持额外的 SNI 证书（`admin.sni_certificates`）。数据库监听器使用普通服务端 TLS（不请求客户端证书）；
只有 HTTP 反向代理监听器请求客户端证书。

## `gated-ca`

一个刻意保持精简的 CA —— 没有证书链，没有 CRL 分发；吊销就是一次数据库查询。

- **根证书**：`generate_root_certificate_rcgen`（`crates/gated-ca/src/lib.rs`）创建名为 "Gated Instance CA"
  （`lib.rs`）的自签名 ECDSA P-384 根证书，有效期 99 年（`lib.rs`）。它在首次数据库引导时生成，存储在
  `Parameters` 行中（`ca_certificate_pem` / `ca_private_key_pem`，`crates/gated-db-entities/src/Parameters.rs`）。
- **签发**：`issue_client_certificate`（`lib.rs`）把用户提供的公钥签成有效期 365 天的客户端证书（`lib.rs`），
  在 subject 中嵌入用户 id，并由 subject + 时间的哈希派生序列号。私钥从不离开用户：用户自己生成密钥对，只提交
  公钥。
- **端点**：自助端点 `POST /api/profile/credentials/certificates`
  （`crates/gated-admin/src/http_service/api/credentials.rs`），以及 `/admin/api/users/:id/credentials/certificates`
  下的管理端变体（`crates/gated-admin/src/api/certificate_credentials.rs`）。签好的 PEM 存为一条
  `CertificateCredential` 行并返回给调用者。
- **吊销**：删除 / 吊销时把证书序列号（base64）插入 `certificate_revocations`
  （`crates/gated-db-entities/src/CertificateRevocation.rs`）；验证时先检查这张表。

## mTLS 持有证明

由 HTTP 反向代理使用，主要面向 Kubernetes 目标，kubectl 配置为使用签发的客户端证书：

1. 代理监听器的 rustls 配置使用 `build_client_cert_verifier`
   （`crates/gated-protocol-http/src/kubernetes/client_certs.rs`）提供的验证器。客户端证书是可选的，但出示的证书
   必须链到实例 CA，且握手中的 `CertificateVerify` 证明了对相应私钥的持有。
2. 共享 HTTP 服务（`crates/gated-common/src/web/server.rs`）把验证过的对端证书放入请求扩展 `ConnectionInfo`。
3. `validate_client_certificate`（`crates/gated-protocol-http/src/kubernetes/auth.rs`）拒绝已吊销的序列号，然后
   查找具有相同 CA 签发序列号的已存储 `CertificateCredential`；匹配成功即以该用户身份认证请求，并更新凭据的
   `last_used`。

没有 kubeconfig 生成器；用户需要手动把签发的证书和自己的私钥配置到 kubectl 或其他客户端。客户端证书在认证策略
系统中也算作一种 `Certificate` 凭据类型（见 [auth.zh-CN.md](auth.zh-CN.md)）。
