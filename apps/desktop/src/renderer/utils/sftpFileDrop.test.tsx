import { describe, expect, test } from "bun:test";
import { extractDroppedFilePaths, isExternalFileDrag } from "./sftpFileDrop";

describe("sftp file drop helpers", () => {
  test("detects external file drags from file items", () => {
    expect(
      isExternalFileDrag({
        types: ["Files"],
        items: [{ kind: "file" }]
      })
    ).toBe(true);

    expect(
      isExternalFileDrag({
        types: ["text/plain"],
        items: [{ kind: "string" }]
      })
    ).toBe(false);
  });

  test("extracts file paths, deduplicates them, and ignores directories", () => {
    const result = extractDroppedFilePaths({
      items: [
        {
          kind: "file",
          getAsFile: () => ({ path: "/tmp/one.json" }),
          webkitGetAsEntry: () => ({ isFile: true, isDirectory: false })
        },
        {
          kind: "file",
          getAsFile: () => ({ path: "/tmp/one.json" }),
          webkitGetAsEntry: () => ({ isFile: true, isDirectory: false })
        },
        {
          kind: "file",
          getAsFile: () => ({ path: "/tmp/folder" }),
          webkitGetAsEntry: () => ({ isFile: false, isDirectory: true })
        }
      ]
    });

    expect(result).toEqual({
      paths: ["/tmp/one.json"],
      allPathsEmpty: false
    });
  });

  test("reports allPathsEmpty when dragged files are present but path resolution fails", () => {
    const result = extractDroppedFilePaths({
      items: [
        {
          kind: "file",
          getAsFile: () => ({ path: "" }),
          webkitGetAsEntry: () => ({ isFile: true, isDirectory: false })
        }
      ]
    });

    expect(result).toEqual({
      paths: [],
      allPathsEmpty: true
    });
  });
});
