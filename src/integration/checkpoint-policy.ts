import type { MemorySpace } from "../application/memory-space.ts";
import { ValidationError } from "../domain/errors.ts";
import type { Checkpoint } from "../domain/types.ts";
import type { CheckpointTrigger } from "../provider/types.ts";

const checkpointTriggers = new Set<CheckpointTrigger>([
  "explicit", "pre_compact", "session_end", "task_completed"
]);

/** Result of policy evaluation, distinguishing a durable checkpoint from a no-op. */
export type CheckpointPolicyResult =
  | { status: "noop"; reason: "no_uncommitted_events"; sessionId: string; trigger: CheckpointTrigger }
  | { status: "completed"; checkpoint: Checkpoint; trigger: CheckpointTrigger };

/** Application-facing checkpoint coordination boundary. */
export interface CheckpointCoordinator {
  checkpointIfNeeded(input: { sessionId: string; trigger: CheckpointTrigger }): Promise<CheckpointPolicyResult>;
}

/** Deterministically checkpoints only new Session events through the latest boundary. */
export class CheckpointPolicy implements CheckpointCoordinator {
  readonly memorySpace: MemorySpace;

  constructor(memorySpace: MemorySpace) {
    this.memorySpace = memorySpace;
  }

  async checkpointIfNeeded(input: {
    sessionId: string;
    trigger: CheckpointTrigger;
  }): Promise<CheckpointPolicyResult> {
    if (!checkpointTriggers.has(input.trigger)) {
      throw new ValidationError(`Unsupported checkpoint trigger: ${String(input.trigger)}`);
    }
    const session = await this.memorySpace.getSession(input.sessionId);
    const latestEvent = await this.memorySpace.getLatestSessionEvent(session.id);
    if (!latestEvent || latestEvent.id === session.lastCheckpointEventId) {
      return {
        status: "noop", reason: "no_uncommitted_events",
        sessionId: session.id, trigger: input.trigger
      };
    }
    const checkpoint = await this.memorySpace.checkpoint({
      sessionId: session.id,
      toEventId: latestEvent.id,
      idempotencyKey: `integration:${session.id}:${input.trigger}:${latestEvent.id}`
    });
    return { status: "completed", checkpoint, trigger: input.trigger };
  }
}
