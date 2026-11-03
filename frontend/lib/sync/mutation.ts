import type { BuildGate, OwnerCommitResult, OwnerSnapshot } from "../storage/vault";
import { encryptProjectionRows, rebuildOwnerProjection } from "./projection";
import { persistLocalOperation, prepareLocalOperation, type LocalOperationDraft } from "./outbox";
import type { Operation } from "./protocol";

export interface LocalMutationResult {
  operation: Operation;
  requestHash: string;
  result: OwnerCommitResult;
  projection: Awaited<ReturnType<typeof rebuildOwnerProjection>>["replay"]["state"];
}

/**
 * Prepare the next immutable envelope, replay the full local union, encrypt its
 * projection, then commit operation + projection + sequence/HLC in one CAS.
 * A conflict means the caller must take a fresh snapshot and prepare again.
 */
export async function commitLocalMutation(input: {
  database: IDBDatabase;
  snapshot: OwnerSnapshot;
  gate: BuildGate;
  expectedBuild: string;
  draft: LocalOperationDraft;
}): Promise<LocalMutationResult> {
  const operation = prepareLocalOperation(input.snapshot, input.draft);
  const { replay } = await rebuildOwnerProjection({
    snapshot: input.snapshot,
    additionalOperations: [operation],
  });
  const projectionWrites = await encryptProjectionRows(input.snapshot, replay.state);
  const committed = await persistLocalOperation({
    database: input.database,
    snapshot: input.snapshot,
    gate: input.gate,
    expectedBuild: input.expectedBuild,
    operation,
    projectionWrites,
  });
  return {
    operation,
    requestHash: committed.requestHash,
    result: committed.result,
    projection: replay.state,
  };
}
