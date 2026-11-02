import {
  MAX_THREAD_WAITS,
  McpCapabilityUnavailableError,
  OrchestrationV2ThreadWait,
  OrchestrationV2ThreadWaiting,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Orchestrator.OrchestratorV2,
];

export class WaitingThreadRequiredError extends Schema.TaggedError<WaitingThreadRequiredError>()(
  "WaitingThreadRequiredError",
  {},
) {
  override get message(): string {
    return "Pass threadId: this MCP client is not running inside a T3 thread.";
  }
}

export class WaitingThreadNotFoundError extends Schema.TaggedError<WaitingThreadNotFoundError>()(
  "WaitingThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class WaitingFromSubagentError extends Schema.TaggedError<WaitingFromSubagentError>()(
  "WaitingFromSubagentError",
  {},
) {
  override get message(): string {
    return "This thread is a subagent, so it cannot set waits. Its parent thread owns them: finish your task and report what you need instead.";
  }
}

export class WaitingSetFailedError extends Schema.TaggedError<WaitingSetFailedError>()(
  "WaitingSetFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not set what the thread is waiting on.";
  }
}

export const WaitingToolError = Schema.Union([
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
  WaitingThreadRequiredError,
  WaitingThreadNotFoundError,
  WaitingFromSubagentError,
  WaitingSetFailedError,
]);
export type WaitingToolError = typeof WaitingToolError.Type;

export const SetWaitingResult = Schema.Struct({
  waiting: Schema.NullOr(OrchestrationV2ThreadWaiting),
});
export type SetWaitingResult = typeof SetWaitingResult.Type;

const SetWaitingTool = Tool.make("set_waiting", {
  description:
    "Record what this thread needs from the user, for their inbox and for tools that filter by kind. `waits` replaces the last list; `[]` clears it. The user's next message clears it too.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId.annotate({ description: "Thread. Default: this thread." })),
    waits: Schema.Array(OrchestrationV2ThreadWait).check(Schema.isMaxLength(MAX_THREAD_WAITS)),
  }),
  success: SetWaitingResult,
  failure: WaitingToolError,
  dependencies,
})
  .annotate(Tool.Title, "Set what the thread is waiting on")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

export const WaitingToolkit = Toolkit.make(SetWaitingTool);
