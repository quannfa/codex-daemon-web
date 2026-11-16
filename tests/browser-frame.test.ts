import assert from "node:assert/strict";
import test from "node:test";
import { compactBrowserMessage, compactBrowserPayload } from "../server/browser-frame";

test("browser frames omit duplicate image data when a saved path exists", () => {
  const result = {
    data: [
      {
        item: {
          id: "image-item",
          type: "imageGeneration",
          result: "A".repeat(2_400_000),
          savedPath: "/home/user/.codex/generated_images/result.png",
        },
      },
    ],
  };
  const compacted = compactBrowserPayload(result) as typeof result;
  const item = compacted.data[0].item as Record<string, unknown>;
  assert.equal(item.savedPath, "/home/user/.codex/generated_images/result.png");
  assert.equal("result" in item, false);
  assert.ok(
    JSON.stringify(compacted).length < 1_000,
    "the browser frame should not contain the duplicate base64 payload",
  );
});

test("browser frame compaction leaves unrelated payloads unchanged", () => {
  const text = JSON.stringify({ id: 1, result: { data: [{ value: "unchanged" }] } });
  assert.equal(compactBrowserMessage(text), text);
});
