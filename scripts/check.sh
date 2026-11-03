#!/usr/bin/env bash
# 阶段检查脚本：服务端隔离回归 + Android Kotlin 编译（不打包 APK、不触碰生产数据）
#
# 用法：
#   ./scripts/check.sh
#   GRADLE_FLAGS=--offline ./scripts/check.sh     # 离线机器（依赖已缓存）
#
# 服务端回归由 test-run.mjs 起独立端口 + 临时数据目录，跑完自动清理。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node（需要 Node.js 18+）" >&2
  exit 1
fi

# 优先使用已设置的 JAVA_HOME；否则尝试常见 JDK 17 路径
if [[ -z "${JAVA_HOME:-}" ]]; then
  for candidate in /opt/java/jdk-17* /usr/lib/jvm/java-17* /usr/lib/jvm/*17*; do
    if [[ -x "$candidate/bin/javac" ]]; then
      export JAVA_HOME="$candidate"
      break
    fi
  done
fi
if [[ -z "${JAVA_HOME:-}" || ! -x "$JAVA_HOME/bin/javac" ]]; then
  echo "未找到 JDK 17（请设置 JAVA_HOME 指向 JDK 17）" >&2
  exit 1
fi

echo "==> 1/2 服务端隔离回归（server/test-run.mjs）"
node server/test-run.mjs

echo
echo "==> 2/2 Android Kotlin 编译（:app:compileDebugKotlin）"
# GRADLE_FLAGS 可传 --offline 等额外参数；保持为空时使用标准在线模式
# shellcheck disable=SC2086
"$ROOT/gradlew" :app:compileDebugKotlin --console=plain ${GRADLE_FLAGS:-}

echo
echo "检查通过：服务端回归 + Kotlin 编译均成功（未打包 APK）"
