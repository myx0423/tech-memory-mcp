# tech-memory-mcp

**不只是记住"说了什么"，而是记住"学到了什么"。**

让 Claude Code 等 AI 编程助手具备长期记忆能力，从每次技术对话中自动提取知识点，下次对话时自动检索相关经验。

## 核心特性

- 🧠 **自动提取**：从对话中识别 decision/lesson/preference/fact/pattern 五类知识
- 🔍 **混合检索**：向量语义搜索 + FTS5 全文搜索，中英文混合查询
- 🇨🇳 **中文优先**：基于 jina-embeddings-v2-base-zh（768 维）嵌入模型
- 📦 **完全本地**：SQLite + Transformers.js，无需外部服务
- 🔄 **跨项目累积**：所有项目知识存入同一数据库，形成终身技术积累

## 系统要求

- **Node.js >= 18.0.0**
- 首次启动下载嵌入模型约 154MB
- **Windows 用户**：如安装失败，请先运行 `npm install --global windows-build-tools`

## 快速开始

### 第一步：配置 Claude Code

在项目根目录或 `~/.claude/` 创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "tech-memory": {
      "command": "npx",
      "args": ["-y", "tech-memory-mcp"]
    }
  }
}
```

### 第二步：验证安装

启动 Claude Code，输入：

```
请调用 tech_stats 查看知识库统计
```

如果返回知识库统计信息（即使为空），说明安装成功。首次启动会自动下载模型，约 30-60 秒。

## 国内网络加速

如果网络环境不佳，可以提前手动下载模型：

### 1. 下载模型文件

从 HuggingFace 镜像站下载模型到本地目录：

```bash
mkdir -p ~/models/jina-embeddings-v2-base-zh
cd ~/models/jina-embeddings-v2-base-zh

# 使用 wget 下载（或使用浏览器手动下载）
wget https://hf-mirror.com/Xenova/jina-embeddings-v2-base-zh/resolve/main/config.json
wget https://hf-mirror.com/Xenova/jina-embeddings-v2-base-zh/resolve/main/model.onnx
wget https://hf-mirror.com/Xenova/jina-embeddings-v2-base-zh/resolve/main/tokenizer.json
wget https://hf-mirror.com/Xenova/jina-embeddings-v2-base-zh/resolve/main/vocab.txt
```

### 2. 配置环境变量

修改 `.mcp.json`，添加 `TECH_MEMORY_MODEL_PATH`：

```json
{
  "mcpServers": {
    "tech-memory": {
      "command": "npx",
      "args": ["-y", "tech-memory-mcp"],
      "env": {
        "TECH_MEMORY_MODEL_PATH": "/Users/yourname/models/jina-embeddings-v2-base-zh"
      }
    }
  }
}
```

Windows 用户示例：

```json
{
  "mcpServers": {
    "tech-memory": {
      "command": "npx",
      "args": ["-y", "tech-memory-mcp"],
      "env": {
        "TECH_MEMORY_MODEL_PATH": "C:\\Users\\yourname\\models\\jina-embeddings-v2-base-zh"
      }
    }
  }
}
```

可选：自定义模型缓存目录（用于自动下载的模型）：

```json
{
  "mcpServers": {
    "tech-memory": {
      "command": "npx",
      "args": ["-y", "tech-memory-mcp"],
      "env": {
        "TECH_MEMORY_CACHE_DIR": "/path/to/cache"
      }
    }
  }
}
```

## MCP 工具

| 工具 | 作用 |
|------|------|
| `tech_search` | 混合搜索（语义 + 全文），支持置信度过滤和过期知识过滤，自动记录曝光事件 |
| `tech_store` | 存储知识点，自动去重，支持置信度和过期时间 |
| `tech_extract_template` | 返回中文知识提取 Prompt + JSON Schema |
| `tech_auto_extract` | 自动从对话中提取并存储技术知识（支持两阶段调用） |
| `tech_confirm` | 确认知识点是否有用，调整置信度，记录采用/拒绝事件 |
| `tech_decay` | 执行知识老化衰减，批量更新置信度，清理过期使用事件 |
| `tech_outdated` | 查询过期或低置信度的知识点 |
| `tech_conflict_scan` | 扫描知识库中的冲突和重复条目 |
| `tech_resolve` | 处理冲突条目（保留、合并或标记矛盾） |
| `tech_link` | 创建知识点之间有向关系 |
| `tech_get` | 查询知识点 + 关联条目 |
| `tech_stats` | 数据库统计 |
| `tech_usage_stats` | 知识库使用统计（曝光、采用、采用率、热门查询） |
| `tech_export` | 导出知识库为 Markdown 或 JSON 格式 |
| `tech_import` | 从 JSON/Markdown/纯文本批量导入知识 |
| `tech_backup` | 创建 SQLite 数据库完整备份 |

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
对话结束 → tech_auto_extract 提取知识点
         → tech_store 存储（自动嵌入 + 语义去重）
         → 下次对话时 tech_search 自动检索相关记忆
         → tech_confirm 反馈知识价值，优化搜索排序
```

## 数据存储

- **数据库**：`~/.tech-memory/memory.db`（SQLite + 内置向量搜索）
- **嵌入模型**：`Xenova/jina-embeddings-v2-base-zh`（q8 量化，154 MB）
- 完全本地，无需任何外部服务

## 开发

```bash
git clone https://github.com/myx0423/tech-memory-mcp.git
cd tech-memory-mcp
npm install
npm run build
node dist/index.js  # 启动 MCP Server
```

运行测试：

```bash
npm test
```

## 姊妹项目

| 项目 | 说明 |
|------|------|
| [**remote-ops-mcp**](https://github.com/myx0423/remote-ops-mcp) | SSH 远程服务器管理：执行命令、部署服务、排查故障。操作失败时自动缓存踩坑上下文，配合 `tech_memory.tech_store` 形成运维知识闭环。 |

## License

MIT
