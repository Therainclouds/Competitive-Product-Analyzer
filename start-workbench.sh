#!/usr/bin/env bash
# 半人半机工作台启动脚本
# 自动从 .env 加载环境变量

set -e

# 切到脚本所在目录
cd "$(dirname "$0")"

# 如果 .env 存在，加载它
if [ -f .env ]; then
  echo "📦 加载 .env ..."
  # 逐行读取 .env，忽略注释和空行
  while IFS='=' read -r key value; do
    # 跳过注释和空行
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    # 去掉值两端的引号
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    export "$key"="$value"
  done < .env
fi

# 启动工作台
echo "🚀 启动半人半机工作台..."
node workbench/server.js
