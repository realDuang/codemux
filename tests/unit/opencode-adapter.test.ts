import { describe, expect, it, vi } from "vitest";
import { createStreamErrorHandler } from "../../electron/main/engines/opencode-adapter";

describe("createStreamErrorHandler", () => {
  it("should ignore EPIPE stream errors", () => {
    const logUnexpected = vi.fn();
    const handleError = createStreamErrorHandler("stdout", logUnexpected);

    handleError({ code: "EPIPE", message: "broken pipe" } as NodeJS.ErrnoException);

    expect(logUnexpected).not.toHaveBeenCalled();
  });

  it("should log unexpected stream errors", () => {
    const logUnexpected = vi.fn();
    const error = { code: "EIO", message: "input/output error" } as NodeJS.ErrnoException;
    const handleError = createStreamErrorHandler("stderr", logUnexpected);

    handleError(error);

    expect(logUnexpected).toHaveBeenCalledWith(
      "Unexpected stderr stream error from OpenCode server process",
      error,
    );
  });
});
