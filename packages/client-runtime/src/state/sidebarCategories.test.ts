import type { ThreadCategory } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveSidebarCategoryScope,
  sidebarCategoryScopeIncludes,
  stepSidebarCategoryScope,
  type SidebarCategoryScope,
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
  const views = [
    { id: "ab", name: "Both", categoryIds: ["a", "b"] },
    { id: "b", name: "Just b", categoryIds: ["b"] },
  ];

  it("steps through everything, each category, and uncategorized threads, in both directions", () => {
    const forward = [];
    let scope = null as Parameters<typeof stepSidebarCategoryScope>[0]["scope"];
    for (let index = 0; index < 4; index += 1) {
      scope = stepSidebarCategoryScope({ scope, categories, views: [], direction: 1 });
      forward.push(scope);
    }
    expect(forward).toEqual([
      { type: "category", categoryId: "a" },
      { type: "category", categoryId: "b" },
      { type: "uncategorized" },
      null,
    ]);
    expect(stepSidebarCategoryScope({ scope: null, categories, views: [], direction: -1 })).toEqual(
      {
        type: "uncategorized",
      },
    );
  });

  it("steps through everything and each view once views exist, starting from a lone category", () => {
    const forward = [];
    let scope = null as Parameters<typeof stepSidebarCategoryScope>[0]["scope"];
    for (let index = 0; index < 3; index += 1) {
      scope = stepSidebarCategoryScope({ scope, categories, views, direction: 1 });
      forward.push(scope);
    }
    expect(forward).toEqual([{ type: "view", viewId: "ab" }, { type: "view", viewId: "b" }, null]);
    expect(stepSidebarCategoryScope({ scope: null, categories, views, direction: -1 })).toEqual({
      type: "view",
      viewId: "b",
    });
    expect(
      stepSidebarCategoryScope({
        scope: { type: "category", categoryId: "a" },
        categories,
        views,
        direction: 1,
      }),
    ).toEqual({ type: "view", viewId: "ab" });
  });

  it("stays on everything when there are no categories", () => {
    expect(
      stepSidebarCategoryScope({ scope: null, categories: [], views: [], direction: 1 }),
    ).toBeNull();
    expect(resolveSidebarCategoryScope({ type: "uncategorized" }, [], [])).toBeNull();
  });

  it("falls back to everything when the focused category was deleted", () => {
    expect(
      resolveSidebarCategoryScope({ type: "category", categoryId: "gone" }, categories, views),
    ).toBeNull();
    expect(
      resolveSidebarCategoryScope({ type: "view", viewId: "gone" }, categories, views),
    ).toBeNull();
    expect(
      stepSidebarCategoryScope({
        scope: { type: "category", categoryId: "gone" },
        categories,
        views: [],
        direction: 1,
      }),
    ).toEqual({ type: "category", categoryId: "a" });
  });

  it("includes a thread when it belongs to the scope's category or any of its view's categories", () => {
    const includes = (scope: SidebarCategoryScope, categoryIds: string[]) =>
      sidebarCategoryScopeIncludes(scope, categoryIds, views);
    expect(includes({ type: "category", categoryId: "a" }, ["b", "a"])).toBe(true);
    expect(includes({ type: "category", categoryId: "a" }, ["b"])).toBe(false);
    expect(includes({ type: "uncategorized" }, [])).toBe(true);
    expect(includes({ type: "uncategorized" }, ["a"])).toBe(false);
    expect(includes({ type: "view", viewId: "b" }, ["a", "b"])).toBe(true);
    expect(includes({ type: "view", viewId: "b" }, ["a"])).toBe(false);
    expect(includes({ type: "view", viewId: "b" }, [])).toBe(false);
    expect(includes({ type: "view", viewId: "gone" }, ["a"])).toBe(false);
  });
});
