import { describe, expect, it } from "vitest";

describe("config", () => {
  it("テスト対象の設定モジュールを読み込める", async () => {
    const config = await import("./config");
    expect(config.loadHostId).toBeTypeOf("function");
    expect(config.signalUrl).toBeTypeOf("function");
  });
});
