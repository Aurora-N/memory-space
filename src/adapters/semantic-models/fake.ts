import type {
  SemanticExtractionModel,
  SemanticExtractionModelInput,
} from "../../ports/semantic-extraction-model.ts";

/** Deterministic semantic model used by P9 tests and offline evaluation only. */
export class ScriptedSemanticExtractionModel implements SemanticExtractionModel {
  readonly run: (input: SemanticExtractionModelInput) => unknown | Promise<unknown>;
  calls: SemanticExtractionModelInput[] = [];

  constructor(run: (input: SemanticExtractionModelInput) => unknown | Promise<unknown>) {
    this.run = run;
  }

  async extract(input: SemanticExtractionModelInput): Promise<unknown> {
    this.calls.push(structuredClone(input));
    return await this.run(input);
  }
}
