import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import { fromRunner, type Runner } from "./textGenerationOperations.ts";
import { buildThreadCategoriesPrompt } from "./textGenerationPrompts.ts";

const decodeCategoriesReply = Schema.decodeUnknownEffect(
  buildThreadCategoriesPrompt({ conversation: "", categories: [], currentCategoryNames: [] })
    .outputSchema,
);

describe("generateThreadCategories", () => {
  const categories = [
    { id: "self", name: "Self Deprecated", description: "Skool and content creation" },
    { id: "gpt", name: "GPT Live" },
    { id: "mobile", name: "Mobile" },
  ];

  const generate = (reply: unknown) => {
    const prompts: string[] = [];
    const run: Runner = (request) => {
      prompts.push(request.prompt);
      return decodeCategoriesReply(reply).pipe(Effect.orDie) as never;
    };
    return fromRunner("Test", run)
      .generateThreadCategories({
        cwd: "/repo",
        conversation: "USER:\nAdd GPT Live voice to the BodyDiff iOS app",
        categories,
        currentCategoryNames: ["T3 Code"],
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "m" },
      })
      .pipe(Effect.map((result) => ({ result, prompts })));
  };

  it.effect("maps the names the model returns back to category ids, in category order", () =>
    Effect.gen(function* () {
      const { result, prompts } = yield* generate({
        categories: [" mobile ", "GPT  Live", "Infra"],
      });
      expect(result.categoryIds).toEqual(["gpt", "mobile"]);
      expect(prompts[0]).toContain("- Self Deprecated: Skool and content creation\n- GPT Live\n");
      expect(prompts[0]).toContain("Already in (context only; do not return these):\n- T3 Code");
      expect(prompts[0]).toContain("BodyDiff iOS app");
    }),
  );

  it.effect("treats a reply without categories as no suggestion", () =>
    Effect.gen(function* () {
      const { result } = yield* generate({});
      expect(result.categoryIds).toEqual([]);
    }),
  );
});
