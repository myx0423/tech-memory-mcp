/**
 * 配置文件：集中管理环境变量
 */

import { existsSync } from "fs";
import { resolve } from "path";

function log(msg: string) {
  process.stderr.write(`[tech-memory:config] ${msg}\n`);
}

/**
 * 获取本地模型路径
 * 优先读取 TECH_MEMORY_MODEL_PATH 环境变量
 */
export function getLocalModelPath(): string | null {
  const modelPath = process.env.TECH_MEMORY_MODEL_PATH;
  
  if (!modelPath) {
    return null;
  }

  const resolvedPath = resolve(modelPath);
  
  if (!existsSync(resolvedPath)) {
    log(`警告: TECH_MEMORY_MODEL_PATH 路径不存在: ${resolvedPath}`);
    return null;
  }

  log(`使用本地模型路径: ${resolvedPath}`);
  return resolvedPath;
}

/**
 * 获取模型缓存目录
 * 优先读取 TECH_MEMORY_CACHE_DIR 环境变量
 */
export function getCacheDir(): string | null {
  const cacheDir = process.env.TECH_MEMORY_CACHE_DIR;
  
  if (!cacheDir) {
    return null;
  }

  const resolvedPath = resolve(cacheDir);
  log(`使用自定义缓存目录: ${resolvedPath}`);
  return resolvedPath;
}
