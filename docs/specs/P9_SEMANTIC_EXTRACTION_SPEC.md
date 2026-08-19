# P9 — Grounded Semantic Memory Extraction Spec

**Status:** READY FOR IMPLEMENTATION / FROZEN FOR P9 v1  
**Phase:** P9  
**Baseline:** `4a1b1a6021c25c338ac5d96ea13d749c5d812b3b`  
**Depends on:** P8 implicit turn-time remember, P7 implicit prompt-time recall, P6 Core/Handoff policy, Provider Integration v1  
**Related:** `./P8_IMPLICIT_REMEMBER_SPEC.md`, `./P7_IMPLICIT_RECALL_SPEC.md`, `./P6_STAGE_B3_CORE_HANDOFF_POLICY_SPEC.md`, `./PROVIDER_INTEGRATION_SPEC.md`, `./DOMAIN_MODEL.md`, `./PRODUCT_SPEC.md`

> P9 extends Memory Space from deterministic pattern extraction to **grounded semantic extraction**: ordinary project conversation may produce durable `MemoryCandidate`s without requiring the user to write `KEY = value`, `Fact:`, `Decision:` or another special syntax.

---

# 1. Product goal

P8 proved that Memory Space can safely and automatically persist conservative user-provided knowledge at assistant-turn time. Its remaining limitation is extraction recall: the built-in extractor recognizes deterministic grammar and a small set of natural-language shapes, but it does not generally understand arbitrary project facts.

P9 must make the following kind of conversation work:

```text
User:
上传组件是通过 variant 来判断是否使用新版样式的，
现在 variant 一共有 a、b、c 三种。
```

without requiring the user to rewrite it as:

```text
UPLOAD_VARIANT_TYPES = a,b,c
```

or:

```text
事实：上传组件的 variant 类型包括 a、b、c。
```

Required P9 conceptual result:

```text
ordinary user language
        ↓
semantic model proposes grounded durable candidate
        ↓
deterministic evidence validation
        ↓
existing P8 implicit admission
        ↓
existing receipt / commit semantics
        ↓
Indexed Memory
```

The defining product invariant is:

> The model may propose what the conversation means; deterministic Memory Space policy still decides whether anything becomes durable Memory.

P9 MUST NOT turn an LLM into a direct Memory writer.

---

# 2. Frozen architecture

P9 reuses the existing provider-neutral extraction port:

```ts
interface MemoryExtractor {
  extract(events: SessionEvent[], context: ExtractionContext): Promise<MemoryCandidate[]>;
}
```

The current architecture already establishes the correct separation:

```text
SessionEvents
    ↓
MemoryExtractor
    ↓
MemoryCandidate[]
    ↓
application/domain policy
    ↓
Memory mutation
```

P9 adds a semantic extraction branch without changing that ownership:

```text
                         ┌──────────────────────────┐
                         │ RuleBasedExtractor       │
                         └────────────┬─────────────┘
                                      │
SessionEvents ────────────────────────┼──→ CompositeMemoryExtractor
                                      │
                         ┌────────────▼─────────────┐
                         │ SemanticMemoryExtractor   │
                         └────────────┬─────────────┘
                                      ↓
                              MemoryCandidate[]
                                      ↓
                         deterministic validators
                                      ↓
                       P8 / checkpoint admission
                                      ↓
                                  Memory
```

The rule-based extractor remains first-class and MUST NOT be replaced by the semantic model.

Reasons:

- deterministic rules are cheaper and faster;
- exact `KEY = value` behavior is already high-precision and stable;
- P7/P8 acceptance fixtures depend on deterministic behavior;
- semantic model outages must not remove already-working deterministic extraction.

---

# 3. Scope

P9 v1 includes:

1. a provider-neutral `SemanticExtractionModel` port;
2. a `SemanticMemoryExtractor` adapter implementing the existing `MemoryExtractor` contract;
3. strict structured model output;
4. candidate grounding against persisted user SessionEvents;
5. deterministic validation of source-event identity and evidence quotes;
6. conservative semantic durability rules;
7. safe coexistence with existing deterministic/project extraction rules;
8. P8 implicit-remember integration with no direct Core writes;
9. checkpoint compatibility through the same extraction port;
10. a separate opt-in project configuration for semantic extraction;
11. fail-safe model/runtime behavior;
12. semantic-extraction-specific quality evaluation;
13. Inspector/diagnostic observability sufficient to answer “why was this candidate accepted/rejected?” without exposing hidden model reasoning;
14. at least one real-model smoke before P9 is declared complete.

P9 v1 is intentionally a **semantic extraction** phase, not a semantic retrieval platform.

---

# 4. Explicit non-goals

P9 v1 MUST NOT introduce:

```text
embedding/vector search
semantic recall/reranking
vector database
semantic nearest-neighbor deduplication
LLM-generated Core Memory
LLM-controlled promotion
LLM direct memory_remember calls
new MCP tools
provider-specific Claude/Codex extraction policy
provider hidden reasoning ingestion
raw tool-result ingestion
repository/codebase autonomous scanning
a second LLM verifier call
background/timer extraction
durable never-persist watermark
full DLP / secret-manager integration
cross-Space semantic merge
semantic contradiction resolver
arbitrary LLM-generated stable keys
retroactive reprocessing of all historical SessionEvents
```

The current six MCP tools remain exactly six.

P7 exact/lexical recall remains unchanged. P9 may create Indexed Memory that P7 lexical mode can later retrieve, but P9 does not redesign P7 ranking or disclosure.

---

# 5. Key design principle — model proposes, code proves

The semantic model is not an admission authority.

Forbidden flow:

```text
LLM decides “important”
        ↓
memory_remember(...)
        ↓
durable Memory
```

Required flow:

```text
LLM proposes structured semantic candidate
        ↓
validate model output schema
        ↓
resolve persisted source events
        ↓
verify quoted evidence
        ↓
verify direct user support
        ↓
semantic safety / durability checks
        ↓
map to MemoryCandidate
        ↓
existing P8 admission / checkpoint policy
        ↓
commit
```

No model field may bypass:

- P8 user-evidence requirements;
- full-source opt-out handling;
- existing Core protection;
- operation restrictions;
- receipt/idempotency semantics;
- Space/Session authority;
- transient rejection;
- credential/sensitive-evidence guards.

---

# 6. Semantic model port

Core/application code MUST NOT depend directly on Claude Code, Codex, or any conversation provider.

Introduce a provider-neutral port conceptually equivalent to:

```ts
export interface SemanticExtractionModelInput {
  schemaVersion: 1;
  events: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
  }>;
}

export interface SemanticExtractionModel {
  extract(input: SemanticExtractionModelInput): Promise<unknown>;
}
```

Exact naming is implementation-owned.

The model port returns untrusted structured data. It does not return `Memory` and does not mutate storage.

## 6.1 Provider independence

Forbidden dependency direction:

```text
SemanticMemoryExtractor
    ↓
ClaudeCodeAdapter / CodexAdapter
```

Required direction:

```text
Semantic model transport adapter
            ↓
SemanticExtractionModel port
            ↓
SemanticMemoryExtractor
            ↓
MemoryExtractor contract
```

The semantic extraction model is a separate capability from the coding-agent provider currently running the Session.

A Codex Session may use the same semantic model as a Claude Session, and vice versa.

## 6.2 Production transport

P9 v1 SHOULD ship one reference production adapter behind the model port using a configurable OpenAI-compatible structured-JSON HTTP model endpoint and Node's built-in HTTP/fetch capability rather than introducing a provider SDK into core.

Protocol-specific request/response code must remain isolated under an adapter boundary such as:

```text
src/adapters/semantic-models/openai-compatible/
```

The exact adapter path is implementation-owned.

This reference adapter does not make OpenAI or any compatible vendor part of the domain contract. A future Anthropic/local/command/native adapter may implement the same port without changing P9 application policy.

Secrets MUST NOT be stored directly in `.memory-space/config.json`. If the reference adapter requires an API key, project configuration may specify an environment-variable name, never the credential value itself.

---

# 7. Project configuration

P9 semantic extraction is a stronger side effect and may incur network/cost. It MUST be independently opt-in and MUST NOT silently change the meaning of existing P8 `implicitRemember.mode = conservative` projects.

Recommended project binding shape:

```json
{
  "version": 1,
  "spaceId": "space_...",
  "implicitRecall": { "mode": "lexical" },
  "implicitRemember": { "mode": "conservative" },
  "semanticExtraction": {
    "mode": "grounded",
    "model": {
      "adapter": "openai-compatible",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "model": "configured-model",
      "apiKeyEnv": "MEMORY_SPACE_SEMANTIC_API_KEY"
    },
    "timeoutMs": 8000
  }
}
```

The example values are illustrative. Normative semantics are below.

## 7.1 Mode

```ts
type SemanticExtractionMode = "off" | "grounded";
```

```text
off
  -> no semantic model call
  -> existing deterministic extraction remains unchanged

grounded
  -> deterministic extraction remains enabled
  -> semantic extractor may additionally propose grounded candidates
```

## 7.2 Defaults

Missing `semanticExtraction` or missing mode:

```text
effective mode = off
source = default
```

P9 MUST NOT automatically enable network/model extraction for pre-P9 project configs.

New `memory-space init` MAY keep semantic extraction off unless the user explicitly configures a model endpoint. Do not write placeholder credentials.

## 7.3 Invalid configuration

Invalid semantic configuration fails closed for semantic extraction while the rest of Memory Space remains usable.

Examples:

```text
semanticExtraction = []
semanticExtraction.mode = "auto"
semanticExtraction.timeoutMs = -1
semanticExtraction.model.apiKey = "raw-secret"   // forbidden field
```

Expected:

```text
Space binding remains usable
deterministic P8 extraction remains available
semantic extraction effective mode = off
doctor/status = ERROR with remediation
normal provider lifecycle continues
```

Do not turn invalid P9 config into `implicitRemember.mode = off` if the P8 configuration itself is valid.

## 7.4 Timeout

Recommended v1 default:

```text
timeoutMs = 8000
```

Allowed configured range SHOULD be bounded, e.g. 1000..30000 ms.

P9 implicit extraction MUST NOT retry model calls automatically inside one assistant-turn lifecycle path. Retry amplification increases latency and cost and may duplicate non-deterministic model output.

---

# 8. Model input contract

P9 reads only the existing bounded, persisted SessionEvent input supplied to extraction.

It MUST NOT send to the semantic model:

- provider hidden reasoning;
- P7 `additionalContext` as authoritative user evidence;
- bootstrap Memory content unless it is itself represented as current Session evidence;
- MCP tool descriptions;
- raw filesystem/code content not present in SessionEvents;
- raw tool output not already authorized as normalized Session evidence.

The model may receive both user and assistant message events for local linguistic context, but **assistant text can never independently ground a durable semantic candidate**.

This deliberately rejects the following v1 pattern:

```text
Assistant:
We should switch the database to PostgreSQL.

User:
OK.
```

P9 v1 MUST NOT persist “database = PostgreSQL” merely because the user said “OK”; the factual content is assistant-originated and not directly quoted in user evidence.

This is a precision-first tradeoff. Future explicit confirmation semantics require a separately reviewed phase.

## 8.1 Input bounds

P9 must not issue one model request per sentence or candidate.

One extraction trigger SHOULD use at most one semantic model request over a bounded event batch.

Recommended hard limits:

```text
max semantic input chars = 12,000
max semantic candidates returned = 8
max evidence quotes per candidate = 3
max quote length = 500 chars
max candidate content length = 1,000 chars
```

Exact constants may differ slightly if tests prove equivalent bounded behavior, but they must be explicit and deterministic.

The P8 source SessionEvents remain unmodified. P9 model-input truncation is a derived view only.

---

# 9. Untrusted semantic proposal schema

The semantic model MUST return a strict JSON object conforming to a versioned schema.

Recommended shape:

```ts
interface SemanticExtractionResponseV1 {
  schemaVersion: 1;
  candidates: SemanticCandidateProposalV1[];
}

interface SemanticCandidateProposalV1 {
  family: "knowledge" | "state";
  type:
    | "fact"
    | "decision"
    | "constraint"
    | "convention"
    | "goal"
    | "task"
    | "progress"
    | "blocker"
    | "question";

  content: string;

  assertion: "direct" | "uncertain" | "hypothetical";
  durability: "durable" | "interaction_local";

  evidence: Array<{
    eventId: string;
    quote: string;
  }>;

  durabilityReason?: string;
}
```

The exact TypeScript file/name is implementation-owned; the semantic constraints are normative.

## 9.1 No model-generated key in P9 v1

The model response MUST NOT control `MemoryCandidate.key`.

P9 v1 semantic candidates are unkeyed unless an existing deterministic extractor independently recognizes a canonical keyed fact.

Reason:

```text
same semantic fact
→ model may invent:
  upload.variant.types
  uploader.variant.options
  upload_component.variant_values
  upload.variant.allowed_values
```

Arbitrary model-generated keys would make the current stable-key identity contract unreliable.

Canonical semantic identity and semantic update merge are deferred to a later P9.x phase.

## 9.2 No model-controlled operation

The model MUST NOT select:

```text
create
update
supersede
ignore
targetMemoryId
recommendedTier
promoteReason
```

After validation, P9 v1 maps an accepted semantic proposal to:

```ts
MemoryCandidate {
  key: undefined,
  operation: "create",
  recommendedTier: "indexed",
  ...
}
```

Semantic P9 implicit writes are therefore always Indexed and cannot autonomously overwrite a keyed canonical Memory.

---

# 10. Semantic extraction prompt contract

The model instruction must be narrow and versioned in source control.

It should ask for:

> Durable project knowledge stated directly by the user that is likely to remain useful in a later coding-agent Session and cannot safely be inferred only from current execution narration.

The model MUST be told to return no candidate for:

```text
current action narration
one-off command/test outcome
assistant-only claims
speculation or guesses
hypothetical suggestions
temporary experiments not adopted as project state
credentials/secrets
requests/questions that do not themselves encode project state
facts not directly supported by quoted user evidence
```

Examples that SHOULD produce semantic proposals:

```text
上传组件是通过 variant 来判断是否使用新版样式的，现在 variant 一共有 a、b、c 三种。

数据库目前使用 PostgreSQL。

我们决定后续上传组件统一保留新版 uploader。

订单创建接口要求 requestId 幂等。

这个 API 只允许客户端版本 8.2 以上调用。

项目里的 service 文件统一使用 XxxService 命名。
```

Examples that SHOULD NOT produce semantic proposals:

```text
我现在检查一下 uploader.ts。

刚才测试挂了。

我猜 variant 可能还有 d。

也许是缓存导致的。

我们先临时试试 PostgreSQL。

帮我看看上传组件。
```

P9 quality evaluation, not prompt prose alone, is the final correctness gate.

---

# 11. Grounding validation

A model proposal is invalid until Memory Space proves its evidence against persisted SessionEvents.

Introduce a deterministic grounding layer before mapping to `MemoryCandidate`.

For every proposed evidence item:

```text
eventId must exist in current Session
AND event must be within the extraction input/range
AND event.type == message
AND event.payload.role == user for durable support
AND quote must be found in the full persisted user content
```

A candidate requires at least one valid user evidence item.

## 11.1 Full source evidence

Grounding MUST use the authoritative persisted SessionEvent, not a bounded/truncated model-input copy.

This preserves the P8 control invariant already established for opt-out.

## 11.2 Quote matching

P9 v1 SHOULD prefer exact substring quote matching against the full persisted user event.

Permitted normalization may include only clearly deterministic operations such as line-ending normalization and surrounding whitespace trimming. Do not use fuzzy semantic quote matching in v1.

If the quoted text cannot be proved against the source event:

```text
candidate rejected
reason = unsupported_evidence
```

No partial candidate content may be persisted.

## 11.3 Claim containment

The evidence quote is a grounding proof, not permission for the model to add materially new claims.

A candidate such as:

```text
quote: "variant 有 a、b、c"
content: "variant 有 a、b、c、d，并且 d 是默认值"
```

must be rejected by validation/evaluation.

P9 v1 may enforce this conservatively through a combination of strict prompt, structured assertion labels, quote-backed tests, and candidate content checks. If a reliable deterministic entailment check cannot be implemented, prefer rejecting complex synthesized candidates and keep candidate content close to evidence wording.

---

# 12. Durability and assertion policy

P9 is precision-first.

Only semantic proposals with:

```text
assertion = direct
durability = durable
```

are eligible to become `MemoryCandidate`s.

Reject:

```text
assertion = uncertain
assertion = hypothetical
durability = interaction_local
```

Additionally, existing deterministic transient policy still runs after candidate mapping.

P9 SHOULD add a narrow deterministic speculative-evidence guard for common markers such as:

```text
可能
也许
大概
猜测
我觉得可能
maybe
might
could be
probably
I think ... maybe
```

The guard should remain narrow and evaluated against source evidence. It must not evolve into an unconstrained sentiment/intent classifier.

Suggested semantic rejection reasons:

```text
unsupported_evidence
assistant_only_evidence
speculative_evidence
interaction_local_evidence
sensitive_evidence
semantic_model_invalid
```

These reasons are internal/sanitized diagnostics; do not include raw secret values.

---

# 13. Sensitive evidence hardening

P8 currently blocks obvious credential-shaped stable keys. P9 introduces unkeyed natural-language facts, so key-only protection is no longer sufficient.

Example that MUST NOT become Memory:

```text
我们的数据库密码是 hunter2。
OPENAI API key 是 sk-....
生产环境 access token 为 ....
```

P9 v1 therefore requires an additional narrow **semantic sensitive-evidence guard** over source user evidence/candidate content.

At minimum detect credential concepts equivalent to:

```text
password / passwd / 密码
api key / api_key / API密钥
access token / 访问令牌
refresh token
private key / 私钥
client secret
credentials / 凭证
```

when presented as an actual value/credential rather than engineering discussion.

Do not reject general engineering prose such as:

```text
我们通过环境变量读取 API key。
TOKEN_BUDGET_LIMIT 是 24000。
设计系统使用 design token。
```

This guard is intentionally narrow. P9 v1 does not claim complete DLP.

Rejected diagnostics and eval reports MUST NOT print the sensitive value.

---

# 14. Mapping validated proposal → MemoryCandidate

After semantic schema, evidence, assertion, durability, and sensitive-data validation succeed, map proposal deterministically.

Recommended v1 mapping:

```ts
{
  family: proposal.family,
  type: proposal.type,
  key: undefined,
  content: normalizedGroundedContent,
  confidence: semanticConfidence,
  importance: 0.5,
  recommendedTier: "indexed",
  sourceEventIds: sortedUniqueUserEvidenceIds,
  operation: "create"
}
```

## 14.1 Confidence

Do not trust a free-form model self-score.

The model response schema does not need a numeric confidence field.

P9 should assign confidence deterministically from validation outcome. A fully grounded, direct, durable semantic proposal may receive a fixed value safely above the existing P8 threshold, for example:

```text
0.90
```

A candidate that fails a validation rule is rejected rather than merely receiving a lower model-derived score.

This preserves the existing P8 `confidence >= 0.85` gate without pretending model confidence is calibrated probability.

## 14.2 Tier

Semantic P9 proposals MUST map to:

```text
recommendedTier = indexed
```

and P8 still forces implicit writes to Indexed.

P9 v1 does not authorize automatic semantic Core promotion.

Checkpoint may process the same extracted evidence but must not invent semantic Core promotion unless an existing deterministic P6 rule independently permits it. If the semantic proposal has no stable key and is recommended Indexed, default outcome remains Indexed.

---

# 15. Deterministic + semantic composition semantics

P9 must preserve deterministic extraction when semantic mode is enabled.

Recommended order:

```text
1. RuleBasedExtractor
2. ProjectExtractionRuleExtractor
3. SemanticMemoryExtractor
4. exact candidate dedup
```

If deterministic and semantic extraction produce the same exact candidate identity, preserve one result.

If deterministic extraction produces a stronger keyed candidate for the same source evidence, do not allow a semantic unkeyed duplicate to create a second Memory for the obvious same statement.

Minimum v1 convergence rule:

```text
same sourceEventIds
+ same family/type
+ normalized semantic content equivalent to deterministic candidate content
→ prefer deterministic candidate
```

Do not implement general semantic-nearest-neighbor dedup in P9 v1.

Different wording in different user events may still create separate unkeyed semantic Memories. This is an accepted P9 v1 limitation and motivates later canonical semantic identity work.

---

# 16. Failure semantics

Semantic model failure must not break existing deterministic P8 behavior.

## 16.1 Implicit remember

For `trigger = implicit_remember`:

```text
deterministic extraction succeeds
semantic model timeout/error/invalid JSON
        ↓
semantic branch returns no candidates + sanitized warning
        ↓
deterministic candidates continue through P8
        ↓
assistant/provider lifecycle remains fail-open
```

A semantic outage MUST NOT suppress an otherwise valid deterministic `KEY = value` candidate.

## 16.2 Checkpoint

When semantic mode is enabled, checkpoint is the final commit opportunity for the uncheckpointed range.

P9 v1 should fail the checkpoint if the semantic model was expected to run but failed before a valid semantic extraction result was obtained:

```text
checkpoint status = failed
checkpoint boundary does not advance
retry remains possible
```

This is intentionally stricter than the turn-time opportunistic path.

If semantic mode is `off`, checkpoint behavior remains the existing deterministic P8/P6 behavior.

Do not silently advance a checkpoint boundary after discarding a configured semantic extraction failure.

---

# 17. Receipt and idempotency compatibility

P9 MUST reuse the frozen P8 candidate fingerprint and receipt semantics.

Do not introduce a second semantic receipt table.

A validated semantic proposal becomes an ordinary `MemoryCandidate`, therefore:

```text
same candidate content
+ same Session
+ same sourceEventIds
        ↓
existing p8:v1 fingerprint
        ↓
existing MemoryCandidateCommitReceipt
```

This preserves:

- replayed Stop idempotency;
- Stop + later checkpoint convergence;
- receipt + Memory transaction semantics;
- checkpoint historical replay protection.

If future P9.x changes canonical semantic identity, it must explicitly review fingerprint compatibility rather than silently changing P8 receipt meaning.

---

# 18. Opt-out semantics

All P8 opt-out behavior remains authoritative.

P9 semantic extraction MUST NOT bypass:

```text
current-turn full prompt opt-out
cross-turn opted-out source-event rejection
```

If a semantic proposal references any user source event carrying `disable_for_turn`:

```text
implicit remember rejects it
reason = opted_out_evidence
```

P9 does not add a durable privacy watermark. Existing P8 rule remains:

```text
later checkpoint may process persisted opted-out SessionEvent
```

Changing that rule is out of scope.

---

# 19. Observability

P9 needs explainability without exposing private chain-of-thought or sensitive content.

Inspector/diagnostics SHOULD expose candidate-level metadata conceptually equivalent to:

```text
source: semantic
schemaVersion: 1
family/type
sourceEventIds
grounding: pass/fail
assertion: direct/uncertain/hypothetical
durability: durable/interaction_local
admission result
rejection reason
committed memoryId (if any)
```

`durabilityReason` may be shown only as short model-provided diagnostic text if it contains no hidden reasoning or sensitive source value. It is not a policy authority and does not need to be persisted into Memory.

Do not log:

- API keys;
- raw credential-like values;
- full model system prompt when it would include secrets;
- hidden model reasoning;
- provider internal traces.

---

# 20. Canonical P9 acceptance scenarios

## 20.1 Natural variant fact — mandatory product scenario

User SessionEvent:

```text
上传组件是通过 variant 来判断是否使用新版样式的，现在 variant 一共有 a、b、c 三种。
```

Assistant produces an ordinary final response.

Required semantic behavior:

```text
semantic extractor called automatically
one grounded knowledge/fact proposal
proposal evidence quotes user text
proposal maps to unkeyed Indexed MemoryCandidate
P8 admission accepts
one active Indexed Memory persists
no memory_remember MCP call required
```

Persisted content must clearly retain:

```text
upload/上传组件
variant
a、b、c
```

## 20.2 Natural stable fact

```text
数据库目前使用 PostgreSQL。
```

Expected:

```text
knowledge/fact
Indexed
user-grounded
```

## 20.3 Natural decision

```text
我们决定后续上传组件统一保留新版 uploader。
```

Expected:

```text
knowledge/decision
Indexed in P9 implicit path
```

## 20.4 Natural constraint

```text
订单创建接口要求 requestId 幂等。
```

Expected:

```text
knowledge/constraint
Indexed
```

## 20.5 Transient narration

```text
我现在检查一下 uploader.ts。
```

Expected:

```text
0 semantic Memory writes
```

## 20.6 Speculation

```text
我猜 variant 可能还有 d。
```

Expected:

```text
0 Memory writes
semantic rejection = speculative_evidence or no proposal
```

## 20.7 Temporary experiment

```text
我们先临时试试 PostgreSQL，看看测试结果。
```

Expected:

```text
0 durable semantic Memory writes
```

## 20.8 Assistant-only proposal

```text
Assistant: We should switch to PostgreSQL.
User: 好。
```

Expected:

```text
0 semantic fact/decision Memory for PostgreSQL
```

## 20.9 Unsupported model claim

Model output attempts:

```text
quote: "variant 有 a、b、c"
content: "variant 有 a、b、c、d"
```

Expected:

```text
candidate rejected
0 Memory write
```

## 20.10 Invalid quote/event identity

Model references unknown event ID or a quote absent from persisted source event.

Expected:

```text
candidate rejected
0 Memory write
```

## 20.11 Semantic sensitive evidence

```text
我们的数据库密码是 <fixture-secret>。
```

Expected:

```text
0 Memory write
rejection reason = sensitive_evidence
logs/report do not contain fixture-secret
```

## 20.12 Existing P8 opt-out

```text
不要记住这次内容。
上传组件的 variant 有 a、b、c 三种。
```

Expected:

```text
P8 bypass
semantic model SHOULD NOT be called for current-turn implicit remember after full control-plane opt-out is known
0 Memory
```

## 20.13 Cross-turn opt-out carry-over

Opted-out source event appears in a later extraction window.

Expected:

```text
semantic proposal referencing opted-out source is rejected
0 delayed semantic write
```

## 20.14 Deterministic fallback under semantic outage

User:

```text
CROSS_AGENT_TEST_20260817 = lavender-731
```

Semantic model times out.

Expected:

```text
rule-based candidate still commits Indexed
semantic warning is sanitized
provider flow continues
```

## 20.15 Checkpoint semantic outage

Semantic mode enabled; model fails during checkpoint.

Expected:

```text
checkpoint failed
lastCheckpointEventId unchanged
retry can later succeed
```

## 20.16 P7 lexical closure

When target project uses:

```json
"implicitRecall": { "mode": "lexical" }
```

Source Session semantically persists the variant fact.

New Session asks:

```text
上传模块的 variant 有什么类型？
```

Expected:

```text
P7 lexical recall can retrieve the Indexed semantic Memory
model can answer a、b、c
```

This validates composition with P7; it does not authorize changes to P7 ranking.

---

# 21. Quality evaluation

Create a dedicated deterministic P9 evaluator, for example:

```text
eval/p9-semantic-extraction.ts
eval/fixtures/p9-semantic-extraction.json
```

Tests MUST use a deterministic fake `SemanticExtractionModel` so CI does not require network credentials.

The fake model returns scripted structured proposals and failure modes; application validation must still prove/reject them exactly as production would.

## 21.1 Required dataset classes

Positive durable fixtures should include at minimum:

```text
component/API fact
database/config fact
project decision
constraint
convention
durable task/state where supported
Chinese and English examples
multi-sentence user message
```

Negative fixtures should include at minimum:

```text
current-action narration
recent command/test result
speculation
hypothesis
short-lived experiment
assistant-only content
assistant proposal + generic user acknowledgement
secret/credential value
invalid quote
unknown source event
opted-out evidence
cross-turn opted-out evidence
```

## 21.2 Primary metrics

P9 quality is precision-first.

Required metrics:

```text
Semantic Durable Precision
Semantic Durable Recall
Unsupported Claim Persistence Rate
Assistant-Only Semantic Persistence Rate
Transient Semantic Persistence Rate
Speculative Semantic Persistence Rate
Sensitive Semantic Persistence Rate
Opt-Out Semantic Violation Rate
Cross-Turn Opt-Out Semantic Violation Rate
Deterministic Fallback Success Rate
Semantic Lifecycle Blocking Failure Rate
```

Initial P9 v1 targets:

```text
Semantic Durable Precision              >= 0.95
Semantic Durable Recall                 >= 0.75
Unsupported Claim Persistence Rate      = 0.0
Assistant-Only Persistence Rate         = 0.0
Transient Persistence Rate              = 0.0
Speculative Persistence Rate            = 0.0
Sensitive Persistence Rate              = 0.0
Opt-Out Violation Rate                  = 0.0
Cross-Turn Opt-Out Violation Rate       = 0.0
Deterministic Fallback Success Rate      = 1.0
Implicit lifecycle blocking failure     = 0.0
```

Hard correctness MUST fail if any safety/persistence rate expected at zero becomes non-zero, even if aggregate recall improves.

Precision is more important than recall:

> Missing a fact can be corrected by later evidence or explicit remember; a false durable Memory can contaminate many future Sessions.

## 21.3 Holdout discipline

Do not tune only against acceptance examples.

Keep a holdout set of natural project statements with wording not copied into the semantic extraction prompt.

Report fixture/holdout results separately where practical.

---

# 22. Real-model evaluation

Before P9 is marked COMPLETE / REVIEW PASS / FROZEN, run at least one real semantic-model smoke using the production model adapter.

The smoke must prove:

```text
normal user natural-language fact
→ real semantic model
→ grounded proposal
→ P8 implicit remember
→ active Indexed Memory
```

Mandatory real smoke source:

```text
上传组件是通过 variant 来判断是否使用新版样式的，现在 variant 一共有 a、b、c 三种。
```

Required observations:

```text
Memory created without explicit memory_remember
Memory is Indexed
source provenance points to user SessionEvent
no assistant-only source accepted
no extra Core write
```

If P7 lexical mode is available in the smoke project, also run a new Session query:

```text
上传模块的 variant 有什么类型？
```

and record whether P7 lexical recall returns the semantic Memory.

The real-model smoke is not a replacement for deterministic fake-model acceptance tests.

Provider/model name and version must be reported honestly. An unavailable model is BLOCKED, never synthetic PASS.

---

# 23. Performance and cost constraints

P9 runs after a reliable assistant final turn and must remain bounded.

Required constraints:

```text
one semantic request max per extraction trigger
bounded input chars
bounded candidate count
bounded timeout
no implicit-path automatic retries
no per-candidate model call
```

Record at least:

```text
semantic call count
latency
input size
candidate count
accepted/rejected count
model timeout/error count
```

Do not place model latency or token accounting into `Memory` domain fields.

A later phase may add caching or batched worker extraction if measured production latency requires it. P9 v1 does not introduce background workers.

---

# 24. Security and trust boundaries

P9 introduces a network/model boundary but does not change authority.

Trust hierarchy remains:

```text
current repository/runtime evidence
explicit current user evidence
        >
historical Memory
        >
assistant/model inference
```

Semantic model output is untrusted.

The semantic model cannot:

- choose Space;
- choose Session;
- select Core;
- promote Memory;
- bypass opt-out;
- bypass sensitive-evidence guard;
- provide arbitrary sourceEventIds without verification;
- mutate SQLite;
- invoke MCP tools;
- decide checkpoint boundary.

Project config must not store model API credentials.

---

# 25. Implementation plan

Implement P9 in small stages. Do not mix semantic recall/vector work into these stages.

## P9.1 — Semantic model + grounded extractor foundation

Deliver:

```text
SemanticExtractionModel port
strict response schema (Zod or equivalent)
SemanticMemoryExtractor
versioned semantic prompt
deterministic fake model
source-event + quote grounding validator
Composite extractor wiring
config mode off/grounded
basic doctor/status visibility
```

Acceptance:

```text
variant natural-language fixture produces grounded MemoryCandidate
unsupported quote cannot become MemoryCandidate
semantic model unavailable does not break deterministic extractor
```

## P9.2 — Conservative semantic admission + quality gates

Deliver:

```text
direct/durable assertion gate
speculative guard
semantic sensitive-evidence guard
P8 admission integration
opt-out/cross-turn regression coverage
semantic eval fixture/report
precision/recall metrics
```

Acceptance:

```text
precision target reached
all zero-tolerance persistence metrics remain zero
```

## P9.3 — Production model adapter + real smoke

Deliver:

```text
reference provider-neutral model transport adapter
safe environment-secret configuration
timeout/error handling
real semantic model smoke
quality result document
```

P9 may be frozen after P9.1–P9.3 pass review.

Canonical semantic identity, semantic merge/update, second-model verifier, embeddings, and semantic recall are separate future phases, not hidden P9.3 work.

---

# 26. Expected code areas

Exact paths may vary, but implementation should remain aligned with current architecture.

Likely additions:

```text
src/ports/semantic-extraction-model.ts
src/integration/semantic-memory-extractor.ts
src/application/semantic-grounding.ts
src/application/semantic-extraction-policy.ts
src/adapters/semantic-models/.../
```

Likely modifications:

```text
src/composition.ts
src/binding/project-config.ts
src/binding/space-resolver.ts
src/integration/implicit-remember.ts
src/application/implicit-remember-admission.ts
src/cli/commands.ts
src/index.ts
```

Likely tests/eval:

```text
test/semantic-memory-extractor.test.ts
test/semantic-extraction-policy.test.ts
test/implicit-remember.test.ts
eval/p9-semantic-extraction.ts
eval/p9-semantic-extraction.test.ts
eval/fixtures/p9-semantic-extraction.json
scripts/p9-real-smoke.mjs
docs/reports/quality/P9_SEMANTIC_EXTRACTION_RESULT.md
```

Do not move provider-neutral policy into `src/adapters/providers/claude-code` or `src/adapters/providers/codex`.

---

# 27. Required non-regression gates

P9 must keep every frozen P7/P8 invariant green.

At minimum rerun:

```text
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run inspector:build
pnpm run check
pnpm run check:workspace
git diff --check
pnpm memory-space eval implicit-remember
```

Add the P9 eval command, for example:

```text
pnpm memory-space eval semantic-extraction
```

The exact CLI spelling may follow existing eval command conventions.

Existing P8 targets must remain unchanged, including:

```text
Implicit Remember Precision = 1.0
Implicit Core Write Rate = 0.0
Same-Evidence Duplicate Rate = 0.0
Replay Duplicate Rate = 0.0
Assistant-Only Persistence Rate = 0.0
Lifecycle Blocking Failure Rate = 0.0
Explicit Opt-Out Violation Rate = 0.0
Long-Assistant User-Evidence Retention = PASS
Checkpoint Historical Replay Count = 0
Secret-Like Auto-Persistence Rate = 0.0
Cross-Turn Opt-Out Violation Rate = 0.0
```

MCP tool count must remain exactly six.

---

# 28. P9 completion gate

P9 is COMPLETE only when all are true:

```text
[ ] semantic extraction is independently opt-in
[ ] existing conservative P8 configs do not silently make network/model calls
[ ] deterministic extractor remains available and unchanged in semantics
[ ] SemanticExtractionModel is provider-neutral
[ ] semantic model output is strict/versioned/untrusted
[ ] every persisted semantic candidate is grounded in full persisted user evidence
[ ] unknown event IDs and unsupported quotes cannot persist
[ ] assistant-only proposal cannot persist
[ ] speculative/hypothetical evidence cannot persist
[ ] transient narration cannot persist
[ ] credential-like natural-language values cannot persist
[ ] P8 current-turn opt-out remains authoritative
[ ] P8 cross-turn opted-out evidence remains ineligible for implicit write
[ ] semantic implicit writes are Indexed-only
[ ] semantic model cannot choose key/operation/tier/targetMemoryId
[ ] P8 receipts remain the only candidate commit receipt mechanism
[ ] semantic outage cannot suppress deterministic implicit writes
[ ] configured semantic checkpoint failure does not advance checkpoint boundary
[ ] P9 deterministic fake-model eval meets all hard targets
[ ] holdout precision is reported
[ ] at least one real semantic-model smoke passes
[ ] P7/P8 non-regression suite remains green
[ ] lint/typecheck/test/build/check/workspace checks pass
[ ] quality result document records actual implementation commits and model evidence
```

Only after review closes these gates may status become:

```text
COMPLETE / REVIEW PASS / FROZEN
```

---

# 29. Accepted P9 v1 limitations

P9 v1 intentionally accepts these limitations:

1. Semantic model calls add latency/cost when enabled.
2. Same semantic fact phrased differently in different source events may produce separate unkeyed Indexed Memories.
3. Model-generated canonical stable keys are not trusted.
4. “Assistant proposes fact; user says OK” is not sufficient direct grounding.
5. P7 exact mode does not magically retrieve unkeyed semantic Memory; lexical mode or explicit search is required.
6. No embedding/vector retrieval.
7. No second-model verifier.
8. Sensitive-evidence guard is narrow, not full DLP.
9. P8 opt-out still does not create a checkpoint-level durable never-persist watermark.
10. Current repository/runtime evidence remains more authoritative than historical semantic Memory.

These are explicit product boundaries, not implementation TODOs that an Agent should silently expand while implementing P9.

---

# 30. Future follow-ups

After P9 v1 is measured and frozen, likely follow-up phases are:

```text
P9.x Semantic Identity
  subject / predicate / value normalization
  deterministic canonical key generation
  semantic update convergence

P10 Semantic Recall
  embeddings/vector or hybrid retrieval
  reranking
  semantic query recall

P11 Semantic Verification (only if measured need)
  optional second-pass verifier
  contradiction checks

Privacy phase
  durable never-persist evidence watermark
  checkpoint-aware privacy policy
```

Do not start these while implementing this spec unless a separate reviewed spec authorizes them.

---

# 31. Coding-agent execution instructions

Before modifying code, the implementation Agent MUST read:

```text
docs/specs/P9_SEMANTIC_EXTRACTION_SPEC.md
docs/specs/P8_IMPLICIT_REMEMBER_SPEC.md
docs/specs/P7_IMPLICIT_RECALL_SPEC.md
docs/specs/P6_STAGE_B3_CORE_HANDOFF_POLICY_SPEC.md
docs/specs/DOMAIN_MODEL.md
docs/specs/PROVIDER_INTEGRATION_SPEC.md
docs/reports/quality/P8_IMPLICIT_REMEMBER_RESULT.md
```

Then inspect at minimum:

```text
src/ports/extractor.ts
src/adapters/rule-based-extractor.ts
src/adapters/declarative-rule-extractor.ts
src/composition.ts
src/integration/implicit-remember.ts
src/application/implicit-remember-admission.ts
src/application/memory-space.ts
src/application/memory-candidate-fingerprint.ts
src/binding/project-config.ts
src/binding/space-resolver.ts
```

Before implementation, write a short root-cause/architecture note covering:

1. why regex/declarative extraction cannot provide broad natural-language recall;
2. why the LLM must remain an extractor rather than admission authority;
3. how full persisted user evidence grounds model output;
4. why semantic extraction needs a separate opt-in from P8 conservative mode;
5. how deterministic extraction survives semantic model failure;
6. why P9 v1 does not allow model-generated stable keys;
7. how P8 receipts/checkpoint convergence remain reusable.

Then implement P9.1 → P9.2 → P9.3 in order.

Do not redesign unrelated P7/P8 architecture.
