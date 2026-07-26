import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { deriveLock, toExactVersion } from "../src/derive-lock.ts";

describe("toExactVersion", () => {
  it("strips caret / tilde / comparator prefixes to an exact version", () => {
    expect(toExactVersion("^18.3.1")).toBe("18.3.1");
    expect(toExactVersion("~15.0.4")).toBe("15.0.4");
    expect(toExactVersion(">=1.2.3")).toBe("1.2.3");
    expect(toExactVersion(">=1.2.3 <2.0.0")).toBe("1.2.3");
  });

  it("leaves an already-exact pin unchanged", () => {
    expect(toExactVersion("18.3.1")).toBe("18.3.1");
  });

  it("passes a wildcard through unchanged (no exact form exists)", () => {
    expect(toExactVersion("*")).toBe("*");
  });
});

describe("deriveLock", () => {
  it("maps package.json dependencies to an exact lockfile", async () => {
    const files = new MemFilesApi();
    await writeText(
      files,
      "/package.json",
      JSON.stringify({
        dependencies: { react: "^18.3.1", "react-dom": "18.3.1", marked: "~15.0.4" },
      }),
    );
    expect(await deriveLock(files)).toEqual({
      react: "18.3.1",
      "react-dom": "18.3.1",
      marked: "15.0.4",
    });
  });

  it("returns an empty lock when there are no dependencies", async () => {
    const files = new MemFilesApi();
    await writeText(files, "/package.json", JSON.stringify({ name: "x" }));
    expect(await deriveLock(files)).toEqual({});
  });
});
