import {
  McpCapabilityUnavailableError,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  UserTodoDeleteResult,
  UserTodoError,
  UserTodoId,
  UserTodoListResult,
  UserTodoMutationResult,
  UserTodoUpsertInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const UserTodosTool = Tool.make("user_todos", {
  description:
    "The user's own todos in this environment: things they mean to do themselves, apart from what threads wait on. list: open ones oldest first, then ones completed in the last 7 days. add: needs title. update: by id; omitted fields stay, null clears. complete, reopen, delete: by id.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    action: Schema.Literals(["list", "add", "update", "complete", "reopen", "delete"]),
    id: Schema.optional(UserTodoId),
    title: UserTodoUpsertInput.fields.title,
    notes: UserTodoUpsertInput.fields.notes,
    where: UserTodoUpsertInput.fields.where,
    notBefore: UserTodoUpsertInput.fields.notBefore,
  }),
  success: Schema.Union([UserTodoListResult, UserTodoMutationResult, UserTodoDeleteResult]),
  failure: Schema.Union([OrchestratorMcpFailure, McpCapabilityUnavailableError, UserTodoError]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Manage the user's todos")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);

export const TodosToolkit = Toolkit.make(UserTodosTool);
