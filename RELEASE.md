# APK 公网分发 · 版本管理

- 站点：https://dl.rose7.cn/ （ECS，`ssh aliyun`）
- 结构：`/var/www/dl/{index.html,releases.json,apk/deepseek-chat-<ver>.apk}`
- 发布：`cd /root/deepseek-app && ./release-apk.sh 1.1.0 "变更1" "变更2"`
- 回滚 Caddy：`cp -a /opt/caddy/Caddyfile.bak-dlmigrate-20261117-173804 /opt/caddy/Caddyfile && (set -a;. /opt/caddy/caddy.env;set +a;/opt/caddy/caddy-alidns reload --config /opt/caddy/Caddyfile --adapter caddyfile --address unix//run/caddy/admin.sock)`
- 回滚版本：从 releases.json 删该条 + 删 apk/ 下该文件即可，历史版本互不影响
