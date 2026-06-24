import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { preprocessChineseForFTS, preprocessQueryForFTS, cosineSimilarity } from "../src/db.js";

describe("db: preprocessChineseForFTS", () => {
  it("should split Chinese text into 2-char segments", () => {
    const result = preprocessChineseForFTS("数据库");
    assert.ok(result.includes("数据"));
    assert.ok(result.includes("据库"));
  });

  it("should handle mixed Chinese and English", () => {
    const result = preprocessChineseForFTS("Docker 容器");
    assert.ok(result.includes("Docker"));
    assert.ok(result.includes("容器"));
  });

  it("should handle empty string", () => {
    const result = preprocessChineseForFTS("");
    assert.equal(result, "");
  });

  it("should handle pure English text", () => {
    const result = preprocessChineseForFTS("hello world");
    assert.ok(result.includes("hello"));
    assert.ok(result.includes("world"));
  });
});

describe("db: preprocessQueryForFTS", () => {
  it("should generate OR conditions for Chinese queries", () => {
    const result = preprocessQueryForFTS("数据库");
    assert.ok(result.includes("OR"));
    assert.ok(result.includes("数据"));
    assert.ok(result.includes("据库"));
  });

  it("should return non-Chinese queries as-is", () => {
    const result = preprocessQueryForFTS("docker");
    assert.equal(result, "docker");
  });

  it("should handle single Chinese character", () => {
    const result = preprocessQueryForFTS("库");
    assert.ok(result.includes("库"));
  });
});

describe("db: cosineSimilarity", () => {
  it("should return 1 for identical vectors", () => {
    const vec = new Float32Array([1, 0, 0]);
    assert.equal(cosineSimilarity(vec, vec), 1);
  });

  it("should return 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    assert.equal(cosineSimilarity(a, b), 0);
  });

  it("should return -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    assert.equal(cosineSimilarity(a, b), -1);
  });

  it("should clamp to [-1, 1]", () => {
    const a = new Float32Array([0.0001, 0.0001]);
    const b = new Float32Array([0.0001, 0.0001]);
    const result = cosineSimilarity(a, b);
    assert.ok(result >= -1 && result <= 1);
  });
});
