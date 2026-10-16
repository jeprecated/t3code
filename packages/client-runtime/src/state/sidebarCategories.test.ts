import type { ThreadCategory } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveSidebarCategoryScope,
  sidebarCategoryScopeIncludes,
  stepSidebarCategoryScope,
} from "./sidebarCategories.ts";

function category(id: string, branch: string): ThreadCategory {
  return {
    id,
    name: id,
    description: "",
    color: "teal",
    rules: [
      {
        repositories: [],
        environments: [],
        providerInstances: [],
        branches: [branch],
        workspacePaths: [],
      },
    ],
  };
}

describe("sidebar category scope", () => {
  const categories = [category("a", "a"), category("b", "b")];

  it("steps through everything, each category, and uncategorized threads, in both directions", () => {
    const forward = [];
    let scope = null as Parameters<typeof stepSidebarCategoryScope>[0]["scope"];
    for (let index = 0; index < 4; index += 1) {
      scope = stepSidebarCategoryScope({ scope, categories, direction: 1 });
      forward.push(scope);
    }
    expect(forward).toEqual([
      { type: "category", categoryId: "a" },
      { type: "category", categoryId: "b" },
      { type: "uncategorized" },
      null,
    ]);
    expect(stepSidebarCategoryScope({ scope: null, categories, direction: -1 })).toEqual({
      type: "uncategorized",
    });
  });

  it("stays on everything when there are no categories", () => {
    expect(stepSidebarCategoryScope({ scope: null, categories: [], direction: 1 })).toBeNull();
    expect(resolveSidebarCategoryScope({ type: "uncategorized" }, [])).toBeNull();
  });

  it("falls back to everything when the focused category was deleted", () => {
    expect(
      resolveSidebarCategoryScope({ type: "category", categoryId: "gone" }, categories),
    ).toBeNull();
    expect(
      stepSidebarCategoryScope({
        scope: { type: "category", categoryId: "gone" },
        categories,
        direction: 1,
      }),
    ).toEqual({ type: "category", categoryId: "a" });
  });

  it("includes a thread in a category scope only when it belongs to that category", () => {
    expect(sidebarCategoryScopeIncludes({ type: "category", categoryId: "a" }, ["b", "a"])).toBe(
      true,
    );
    expect(sidebarCategoryScopeIncludes({ type: "category", categoryId: "a" }, ["b"])).toBe(false);
    expect(sidebarCategoryScopeIncludes({ type: "uncategorized" }, [])).toBe(true);
    expect(sidebarCategoryScopeIncludes({ type: "uncategorized" }, ["a"])).toBe(false);
  });
});
