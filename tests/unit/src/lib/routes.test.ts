import { describe, expect, it } from "vitest";
import { CONNECTION_CENTER_PATH } from "../../../../src/lib/routes";

describe("routes", () => {
  it("keeps the connection center off the home route, which opens chat on the host", () => {
    expect(CONNECTION_CENTER_PATH).toBe("/connections");
    expect(CONNECTION_CENTER_PATH).not.toBe("/");
  });
});
