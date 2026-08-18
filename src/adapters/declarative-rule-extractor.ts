import { ValidationError } from "../domain/errors.ts";
import type { MemoryCandidate, MemoryFamily, SessionEvent } from "../domain/types.ts";
import type { ExtractionContext, MemoryExtractor } from "../ports/extractor.ts";
import { builtInKeySchemas, builtInMemoryKeys } from "./extraction-contract.ts";
import { isTransientExtractionEvidence } from "./extraction-policy.ts";

const families = new Set<MemoryFamily>(["knowledge", "state", "episode", "procedure"]);
const ruleFields = new Set([
  "id",
  "enabled",
  "family",
  "type",
  "key",
  "match",
  "contentTemplate",
  "coreCandidate",
]);
const matchFields = new Set(["kind", "prefixes", "value", "caseSensitive"]);
const reservedRuleIds = new Set(["builtin.project.current-task"]);

const MAX_RULES = 64;
const MAX_PREFIXES = 16;
const MAX_PREFIX_LENGTH = 120;
const MAX_TEMPLATE_LENGTH = 500;
const MAX_CAPTURE_LENGTH = 1_000;
const MAX_CONTENT_LENGTH = 2_000;
const VALUE_PLACEHOLDER = "$" + "{value}";

/** Safe declarative rule that captures the remainder after one configured prefix. */
export interface DeclarativeExtractionRule {
  id: string;
  family: MemoryFamily;
  type: string;
  key?: string;
  match: {
    kind: "prefix";
    prefixes: string[];
    value: "text" | "identifier";
    caseSensitive: boolean;
  };
  contentTemplate: string;
  coreCandidate: boolean;
  confidence: number;
  importance: number;
  promoteReason?: string;
}

/** Parsed project rule file containing only enabled and validated rules. */
export interface ProjectExtractionRules {
  version: 1;
  rules: DeclarativeExtractionRule[];
}

/** Built-in special cases expressed through the same bounded declarative engine. */
export const builtInExtractionRules: readonly DeclarativeExtractionRule[] = [
  {
    id: "builtin.project.current-task",
    family: "state",
    type: "task",
    key: builtInMemoryKeys.currentTask,
    match: {
      kind: "prefix",
      prefixes: ["先完成", "先实现"],
      value: "text",
      caseSensitive: false,
    },
    contentTemplate: `完成 ${VALUE_PLACEHOLDER}`,
    coreCandidate: true,
    confidence: 0.9,
    importance: 0.8,
    promoteReason: "Explicit current next task",
  },
];

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new ValidationError(`${label}.${unexpected} is not supported`);
}

function string(value: unknown, label: string, maximum: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new ValidationError(`${label} exceeds ${maximum} characters`);
  }
  if (pattern && !pattern.test(normalized)) {
    throw new ValidationError(`${label} has an unsupported format`);
  }
  return normalized;
}

function optionalBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ValidationError(`${label} must be a boolean`);
  return value;
}

function parseMatch(value: unknown, label: string): DeclarativeExtractionRule["match"] {
  const input = object(value, label);
  exactFields(input, matchFields, label);
  if (input.kind !== "prefix") {
    throw new ValidationError(`${label}.kind must be prefix`);
  }
  if (
    !Array.isArray(input.prefixes) ||
    input.prefixes.length === 0 ||
    input.prefixes.length > MAX_PREFIXES
  ) {
    throw new ValidationError(
      `${label}.prefixes must contain between 1 and ${MAX_PREFIXES} strings`
    );
  }
  const prefixes = input.prefixes.map((prefix, index) =>
    string(prefix, `${label}.prefixes[${index}]`, MAX_PREFIX_LENGTH)
  );
  const caseSensitive = optionalBoolean(input.caseSensitive, `${label}.caseSensitive`, false);
  const normalizedPrefixes = prefixes.map((prefix) =>
    caseSensitive ? prefix : prefix.toLowerCase()
  );
  if (new Set(normalizedPrefixes).size !== normalizedPrefixes.length) {
    throw new ValidationError(`${label}.prefixes must be unique`);
  }
  const capture = input.value ?? "text";
  if (capture !== "text" && capture !== "identifier") {
    throw new ValidationError(`${label}.value must be text or identifier`);
  }
  return { kind: "prefix", prefixes, value: capture, caseSensitive };
}

function parseTemplate(value: unknown, label: string): string {
  const template = string(value, label, MAX_TEMPLATE_LENGTH);
  if (!template.includes(VALUE_PLACEHOLDER) || /\$\{(?!value\})/u.test(template)) {
    throw new ValidationError(`${label} must use only the \${value} placeholder`);
  }
  return template;
}

function parseRule(value: unknown, index: number): DeclarativeExtractionRule | undefined {
  const label = `rules[${index}]`;
  const input = object(value, label);
  exactFields(input, ruleFields, label);
  if (!optionalBoolean(input.enabled, `${label}.enabled`, true)) return undefined;
  const id = string(input.id, `${label}.id`, 80, /^[a-z0-9][a-z0-9._-]*$/u);
  if (reservedRuleIds.has(id)) {
    throw new ValidationError(`${label}.id is reserved by a built-in rule`);
  }
  const family = string(input.family, `${label}.family`, 20) as MemoryFamily;
  if (!families.has(family)) throw new ValidationError(`${label}.family is unsupported`);
  const type = string(input.type, `${label}.type`, 64, /^[a-z][a-z0-9_-]*$/u);
  const key =
    input.key === undefined
      ? undefined
      : string(input.key, `${label}.key`, 128, /^[a-z0-9][a-z0-9._:-]*$/iu);
  const builtInType = key ? builtInKeySchemas.get(key) : undefined;
  if (builtInType !== undefined && builtInType !== `${family}:${type}`) {
    throw new ValidationError(`${label}.key conflicts with the built-in key schema`);
  }
  const coreCandidate = optionalBoolean(input.coreCandidate, `${label}.coreCandidate`, false);
  return {
    id,
    family,
    type,
    key,
    match: parseMatch(input.match, `${label}.match`),
    contentTemplate: parseTemplate(input.contentTemplate, `${label}.contentTemplate`),
    coreCandidate,
    confidence: 0.9,
    importance: coreCandidate ? 0.8 : 0.5,
    promoteReason: coreCandidate ? `Configured extraction rule ${id}` : undefined,
  };
}

/** Parses the versioned untrusted project rule document without accepting executable code. */
export function parseProjectExtractionRules(value: unknown): ProjectExtractionRules {
  const input = object(value, "extraction rules");
  exactFields(input, new Set(["version", "rules"]), "extraction rules");
  if (input.version !== 1) throw new ValidationError("extraction rules.version must be 1");
  if (!Array.isArray(input.rules) || input.rules.length > MAX_RULES) {
    throw new ValidationError(`extraction rules.rules must contain at most ${MAX_RULES} rules`);
  }
  const rules = input.rules
    .map(parseRule)
    .filter((rule): rule is DeclarativeExtractionRule => rule !== undefined);
  const ids = new Set<string>();
  const keyTypes = new Map<string, string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) throw new ValidationError(`Duplicate extraction rule id: ${rule.id}`);
    ids.add(rule.id);
    if (!rule.key) continue;
    const schema = `${rule.family}:${rule.type}`;
    const existing = keyTypes.get(rule.key);
    if (existing !== undefined && existing !== schema) {
      throw new ValidationError(`Extraction rule key ${rule.key} has conflicting schemas`);
    }
    keyTypes.set(rule.key, schema);
  }
  return { version: 1, rules };
}

function capturedValue(line: string, rule: DeclarativeExtractionRule): string | undefined {
  const source = rule.match.caseSensitive ? line : line.toLowerCase();
  for (const prefix of rule.match.prefixes) {
    const expected = rule.match.caseSensitive ? prefix : prefix.toLowerCase();
    if (!source.startsWith(expected)) continue;
    const remainder = line.slice(prefix.length).trim();
    if (remainder === "" || remainder.length > MAX_CAPTURE_LENGTH) return undefined;
    if (rule.match.value === "text") return remainder;
    return remainder.match(/^[A-Za-z](?:[\w.+-]*[\w+])?/u)?.[0];
  }
  return undefined;
}

/** Extracts deterministic candidates from bounded declarative prefix rules. */
export class DeclarativeRuleExtractor implements MemoryExtractor {
  readonly rules: readonly DeclarativeExtractionRule[];

  constructor(rules: readonly DeclarativeExtractionRule[]) {
    this.rules = rules;
  }

  /** Extracts every configured candidate for one normalized message line. */
  extractLine(line: string, sourceEventId: string): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];
    for (const rule of this.rules) {
      const value = capturedValue(line, rule);
      if (!value || isTransientExtractionEvidence(line) || isTransientExtractionEvidence(value)) {
        continue;
      }
      const content = rule.contentTemplate.replaceAll(VALUE_PLACEHOLDER, value).trim();
      if (content === "" || content.length > MAX_CONTENT_LENGTH) continue;
      candidates.push({
        family: rule.family,
        type: rule.type,
        key: rule.key,
        content,
        confidence: rule.confidence,
        importance: rule.importance,
        recommendedTier: rule.coreCandidate ? "core" : "indexed",
        promoteReason: rule.promoteReason,
        sourceEventIds: [sourceEventId],
        operation: rule.key ? "update" : "create",
      });
    }
    return candidates;
  }

  async extract(events: SessionEvent[], _context: ExtractionContext): Promise<MemoryCandidate[]> {
    const candidates: MemoryCandidate[] = [];
    for (const event of events) {
      if (event.type !== "message") continue;
      const text = event.payload.text ?? event.payload.content;
      if (typeof text !== "string") continue;
      const lines = text
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
      for (const line of lines) {
        candidates.push(...this.extractLine(line, event.id));
      }
    }
    return candidates;
  }
}

function candidateIdentity(candidate: MemoryCandidate): string {
  return JSON.stringify([
    candidate.family,
    candidate.type,
    candidate.key ?? "",
    candidate.content,
    candidate.operation,
    candidate.sourceEventIds,
  ]);
}

/** Runs extractors in order and removes only exact duplicate candidates. */
export class CompositeMemoryExtractor implements MemoryExtractor {
  readonly extractors: readonly MemoryExtractor[];

  constructor(extractors: readonly MemoryExtractor[]) {
    this.extractors = extractors;
  }

  async extract(events: SessionEvent[], context: ExtractionContext): Promise<MemoryCandidate[]> {
    const candidates: MemoryCandidate[] = [];
    const seen = new Set<string>();
    for (const extractor of this.extractors) {
      for (const candidate of await extractor.extract(events, context)) {
        const identity = candidateIdentity(candidate);
        if (seen.has(identity)) continue;
        seen.add(identity);
        candidates.push(candidate);
      }
    }
    return candidates;
  }
}
