# 安全策略

## 支持版本

| 版本    | 支持 |
| ----- | -- |
| 0.2.x | ✅  |
| < 0.2 | ❌  |

## 报告漏洞

请**不要**开公开 issue。用 GitHub 的  
[Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidelines-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)  
私下报告。

也可以邮件联系维护者（地址见仓库主页）。

## 说明

本插件会自动操作浏览器与本地文件系统，主要风险面：

- **浏览器 profile**：存放登录态（Cookie）。目录默认在 `$DSH_HOME/cx-learn/browser-profile/`，  
  不要提交到版本库或分享出去。
- **模型凭据**：插件不保存任何密钥，一律从环境变量读。  
  但如果你在设置里填了自定义路径，注意别指向敏感位置。
- **loopback ask 端点**：插件会在 `127.0.0.1` 上开一个随机端口的答题回调服务，  
  带一次性 token 校验。只监听回环地址，不对外暴露。
