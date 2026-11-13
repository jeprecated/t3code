import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as UserTodoService from "../../../userTodos/UserTodoService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { TodosToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const todos = yield* UserTodoService.UserTodoService;
  const orchestration = McpInvocationContext.requireMcpCapability("orchestration");

  return {
    user_todos: McpToolAccess.either(
      (input) => input.action === "list",
      McpToolAccess.reads(() => orchestration.pipe(Effect.andThen(todos.list()))),
      McpToolAccess.writes(
        ({ action, id, environmentId: _environmentId, ...fields }) =>
          Effect.gen(function* () {
            yield* orchestration;
            if (action === "add") return yield* todos.upsert({ ...fields, createdBy: "agent" });
            if (id === undefined) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: `Pass the todo's id to ${action} it.`,
              });
            }
            switch (action) {
              case "update":
                return yield* todos.upsert({ ...fields, id, createdBy: "agent" });
              case "complete":
              case "reopen":
                return yield* todos.setCompleted({ id, completed: action === "complete" });
              default:
                return yield* todos.delete({ id });
            }
          }),
        // The todos are the user's, whichever of their machines the agent runs on.
        { linkedCallers: "allowed" },
      ),
    ),
  } satisfies McpToolAccess.Handlers<typeof TodosToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(TodosToolkit, make);
