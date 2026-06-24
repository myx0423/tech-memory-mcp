/**
 * Chinese Embedding Pipeline using Transformers.js
 *
 * Model: Xenova/jina-embeddings-v2-base-zh (q8 quantized, 154 MB)
 * Output: 768-dimensional normalized vectors with mean pooling.
 *
 * ALL logging goes to stderr — MCP uses stdout for JSON-RPC.
 */

import { pipeline, env } from "@huggingface/transformers";
import type { Pipeline } from "@huggingface/transformers";
import { getLocalModelPath, getCacheDir } from "./config.js";

// ── HuggingFace mirror for China accessibility ─────────────────────────
// Default to hf-mirror.com; override with HF_ENDPOINT env var if set.
// e.g. HF_ENDPOINT=https://huggingface.co for direct access.
if (!env.remoteHost || env.remoteHost === "https://huggingface.co/") {
  env.remoteHost = process.env.HF_ENDPOINT || "https://hf-mirror.com/";
}

// ── Custom cache directory ─────────────────────────────────────────────
const customCacheDir = getCacheDir();
if (customCacheDir) {
  env.cacheDir = customCacheDir;
}

// ── Logging (stderr only) ──────────────────────────────────────────────
function log(msg: string) {
  process.stderr.write(`[tech-memory:embeddings] ${msg}\n`);
}

// ── Model config ───────────────────────────────────────────────────────
const MODEL_ID = "Xenova/jina-embeddings-v2-base-zh";
const MODEL_DTYPE = "q8";

// ── Singleton state ────────────────────────────────────────────────────
let _pipe: Pipeline | null = null;
let _initPromise: Promise<Pipeline> | null = null;

// ── Progress callback ──────────────────────────────────────────────────
function progressCallback(progress: any) {
  if (progress?.status === "progress" && progress?.file) {
    // Transformers.js reports progress as 0-100 already (percentage).
    // Only show every 10% to avoid log flood.
    const pct = progress?.progress != null ? progress.progress : -1;
    if (pct >= 0 && Math.floor(pct) % 10 === 0) {
      log(`下载中 ${progress.file}: ${pct.toFixed(0)}%`);
    }
  } else if (progress?.status === "ready") {
    log("模型加载完成");
  }
}

// ── Lazy initialization with latch ─────────────────────────────────────
async function getPipeline(): Promise<Pipeline> {
  if (_pipe) return _pipe;

  if (_initPromise) {
    log("嵌入模型初始化进行中，等待...");
    return _initPromise;
  }

  _initPromise = (async () => {
    const start = Date.now();
    
    // 检查是否配置了本地模型路径
    const localModelPath = getLocalModelPath();
    const modelSource = localModelPath || MODEL_ID;
    
    if (localModelPath) {
      log(`从本地路径加载嵌入模型: ${localModelPath}`);
    } else {
      log(`加载嵌入模型: ${MODEL_ID} (${MODEL_DTYPE}, ~154 MB)`);
      log("首次使用需下载模型，约 30-60 秒...");
    }

    try {
      // Transformers.js pipeline() has complex generic overloads that tsc can't resolve.
      // The runtime behavior is correct — just bypass the type checker here.
      const pipe = (await (pipeline as any)(
        "feature-extraction",
        modelSource,
        {
          dtype: MODEL_DTYPE,
          progress_callback: progressCallback,
        }
      )) as Pipeline;

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      log(`模型就绪，耗时 ${elapsed}s`);
      _pipe = pipe;
      return pipe;
    } catch (err) {
      // Clear the latch so subsequent calls retry instead of returning the
      // same rejected promise forever.
      _initPromise = null;
      
      // 如果是本地路径加载失败，给出明确的错误提示
      if (localModelPath) {
        const errorMsg = `TECH_MEMORY_MODEL_PATH 路径无效或模型不兼容，请检查路径: ${localModelPath}`;
        log(`错误: ${errorMsg}`);
        throw new Error(errorMsg);
      }
      
      throw err;
    }
  })();

  return _initPromise;
}

// ── Public API ─────────────────────────────────────────────────────────

export async function getEmbedding(texts: string[]): Promise<Float32Array[]> {
  const pipe = await getPipeline();

  const output = await pipe(texts, {
    pooling: "mean" as const,
    normalize: true,
  });

  // output.data is Float32Array with shape [N * 768]
  const data: Float32Array = (output as any).data;
  const dim = 768;
  const results: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    results.push(data.slice(i * dim, (i + 1) * dim));
  }
  return results;
}

export async function getSingleEmbedding(text: string): Promise<Float32Array> {
  const results = await getEmbedding([text]);
  return results[0];
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return Math.max(-1, Math.min(1, dot));
}

export async function warmupEmbeddings(): Promise<void> {
  await getPipeline();
  log("嵌入模型预热完成");
}
