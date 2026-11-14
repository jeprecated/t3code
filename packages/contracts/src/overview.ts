import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const OverviewStartInput = Schema.Struct({
  /** The project for a new overview thread. Default: a dedicated Overview project. */
  projectId: Schema.optional(ProjectId),
  /** The model a new thread would get on the client. Default: the project's default model. */
  modelSelection: Schema.optional(ModelSelection),
});
export type OverviewStartInput = typeof OverviewStartInput.Type;

export const OverviewStartResult = Schema.Struct({ threadId: ThreadId });
export type OverviewStartResult = typeof OverviewStartResult.Type;

export class OverviewStartError extends Schema.TaggedError<OverviewStartError>()(
  "OverviewStartError",
  {
    stage: Schema.Literals(["settings", "project", "thread", "schedule"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not start the overview agent (${this.stage}).`;
  }
}
