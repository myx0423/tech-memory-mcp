# tech-memory-mcp

面向 AI Agent 的中文技术知识记忆 MCP Server。

**不只是记住"说了什么"，而是记住"学到了什么"。**

`tech-memory-mcp` 让 AI 编程助手具备长期记忆能力：从每一次技术对话中自动提取有价值的知识点，存储到本地向量数据库，下次对话时自动检索相关经验。中文优先，完全离线。

### 核心特性

- 🇨🇳 **中文优先**：基于 jina-v2-base-zh（768 维）嵌入模型，对中文技术内容进行语义理解
- 🧠 **自动提取**：内置知识提取模板，LLM 可从对话中识别 decision/lesson/preference/fact/pattern 五类知识
- 🔍 **混合检索**：向量语义搜索 + SQLite FTS5 全文搜索，RRF 融合排序，中英文混合查询
- 🔗 **知识图谱**：支持知识点之间有向关系（依赖、替代、矛盾），构建技术知识网络
- 📦 **完全本地**：SQLite + Transformers.js，无需任何外部服务或 API
- 🔄 **跨项目累积**：所有项目的知识存入同一数据库，形成终身技术积累

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
git clone https://github.com/myx0423/tech-memory-mcp.git
cd tech-memory-mcp
npm install
npm run build
node dist/index.js  # 启动 MCP Server
```

## 姊妹项目

| 项目 | 说明 |
|------|------|
| [**remote-ops-mcp**](https://github.com/myx0423/remote-ops-mcp) | SSH 远程服务器管理：执行命令、部署服务、排查故障。操作失败时自动缓存踩坑上下文，配合 `tech_memory.tech_store` 形成运维知识闭环。 |

## License

MIT
