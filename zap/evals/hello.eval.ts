import { describe, it, expect } from "vitest";
import { createThread, MockTools } from "@0north/zap-eval-harness";
describe("hello world", () => {
  it("responds to a basic greeting", async () => {
    const thread = await createThread({ tools: new MockTools() });
    const result = await thread.send("Hi! Please reply with the word 'hello'.");
    expect(result).toHaveNoErrors();
    expect(result.response.toLowerCase()).toContain("hello");
  });
});