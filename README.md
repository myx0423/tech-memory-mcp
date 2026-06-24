# tech-memory-mcp

中文优先的 AI Agent 技术知识记忆 MCP Server。

**不只是记住"说了什么"，而是记住"学到了什么"。**

## 和现有方案的区别

| | episodic-memory | OMEGA | tech-memory-mcp |
|---|---|---|---|
| 定位 | 对话存档 | 通用知识记忆 | **技术知识积累** |
| 语言 | 英文 | 英文 | **中文优先** |
| 提取 | ❌ 只存档 | ✅ 英文提取 | ✅ **中文提取** |
| 知识图谱 | ❌ | ✅ | ✅ 有向关系 |
| 嵌入模型 | all-MiniLM-L6 (23MB) | bge-small-en (90MB) | **jina-v2-base-zh (154MB)** |
| 跨项目 | 按项目隔离 | 跨项目 | **跨项目终身累积** |

## 快速开始

```bash
# 安装
npx -y tech-memory-mcp@latest

# 配置 Claude Code (.mcp.json 或 ~/.claude/.mcp.json)
{
  "mcpServers": {
    "tech-memory": {
      "command": "npx",
      "args": ["-y", "tech-memory-mcp"]
    }
  }
}
```

首次启动会下载中文嵌入模型 (~154 MB)，约 30-60 秒。

## MCP 工具

| 工具 | 作用 |
|------|------|
| `tech_search` | 混合搜索（语义 + 全文），支持按类型/项目/标签过滤 |
| `tech_store` | 存储知识点，自动去重 |
| `tech_extract_template` | 返回中文知识提取 Prompt + JSON Schema |
| `tech_link` | 创建知识点之间的有向关系 |
| `tech_get` | 查询知识点 + 关联条目 |
| `tech_stats` | 数据库统计 |

## 知识分类

| 类型 | 说明 | 示例 |
|------|------|------|
| `decision` | 技术决策 | "选了 Calico 而非 Flannel，因为需要 NetworkPolicy" |
| `lesson` | 经验教训 | "kubeadm init 失败记得先 kubeadm reset -f" |
| `preference` | 个人偏好 | "更喜欢用 Containerd 而非 Docker 作为运行时" |
| `fact` | 技术事实 | "K8s v1.34 对应 Containerd 沙箱镜像 pause:3.10" |
| `pattern` | 通用模式 | "三 Master + Nginx + KeepAlived 是生产标配" |

## 工作原理

```
对话结束 → tech_extract_template 获取提取 Prompt
         → LLM 从对话中提取知识点（中文，结构化 JSON）
         → tech_store 存储（自动嵌入 + 语义去重）
         → 下次对话时 tech_search 自动检索相关记忆
```

## 数据存储

- 数据库：`~/.tech-memory/memory.db`（SQLite + sqlite-vec）
- 嵌入模型：`Xenova/jina-embeddings-v2-base-zh`（q8 量化，154 MB）
- 完全本地，无需任何外部服务

## 开发

```bash
git clone https://github.com/your-username/tech-memory-mcp.git
cd tech-memory-mcp
npm install
npm run build
node dist/index.js  # 启动 MCP Server
```

## License

MIT
