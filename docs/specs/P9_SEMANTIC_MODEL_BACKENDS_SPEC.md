# P9 — Semantic Model Backends & Zero-API Setup Spec

**Status:** READY FOR IMPLEMENTATION / FROZEN FOR P9 backend integration  
**Phase:** P9 backend amendment  
**Baseline:** `dee763a1df265b3a93809bb2ce4edf129fa52fe1`  
**Depends on:** `./P9_SEMANTIC_EXTRACTION_SPEC.md`, P8 implicit remember, Provider Integration v1  
**Normative relationship:** This document **amends and supersedes** P9 `§6.2 Production transport`, the model-backend/configuration portions of `§7 Project configuration`, and the production-backend staging in `§25 Implementation plan`. All P9 grounding, evidence, admission, Indexed-only, receipt, checkpoint, evaluation, and non-goal rules remain authoritative unless this document explicitly changes them.

> Product goal: users may choose how Memory Space obtains semantic extraction capability. They may use an external model API, a local model runtime, or — when a real capability gate passes — an already-installed coding-agent CLI without configuring a second model API. The chosen model is a capability source, never a trust source.

---

# 1. Product decision

P9 MUST separate:

```text
coding-agent provider
  Claude Code / Codex / future provider

from

semantic-extraction model backend
  external API / local model / host agent
```

The user chooses the semantic backend explicitly.

The chosen backend MUST NOT change the downstream Memory safety pipeline:

```text
bounded persisted SessionEvents
        ↓
SemanticExtractionModel
        ↓
untrusted semantic proposal
        ↓
schema validation
        ↓
deterministic grounding against persisted user evidence
        ↓
full-source opt-out / sensitive / transient policy
        ↓
existing P8 admission
        ↓
receipt / convergence
        ↓
Indexed Memory
```

Frozen invariant:

> **Model backend is a capability source, not a trust source.**

A model reached through Claude Code, Codex, Ollama, OpenAI-compatible HTTP, or any future adapter has exactly the same authority: propose untrusted semantic candidates only.

---

# 2. Supported backend classes

P9 backend integration recognizes three backend classes:

```ts
type SemanticModelBackend =
  | "external"
  | "local"
  | "host-agent";
```

Conceptually:

```text
                         SemanticModelResolver
                                  │
             ┌────────────────────┼────────────────────┐
             │                    │                    │
             ▼                    ▼                    ▼
      external backend       local backend       host-agent backend
             │                    │                    │
 OpenAI-compatible HTTP      Ollama / local       isolated coding-agent
                              model runtime          CLI invocation
             │                    │                    │
             └────────────────────┴────────────────────┘
                                  │
                                  ▼
                     SemanticExtractionModel port
                                  │
                                  ▼
                      SemanticMemoryExtractor
```

P9 MUST NOT encode backend-specific behavior in `MemorySpace`, P8 admission, Memory domain types, SQLite, or provider lifecycle normalization.

---

# 3. Unified model port

The P9 `SemanticExtractionModel` port remains the stable execution boundary.

Conceptual contract:

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

Adapters implement this port. They MUST NOT return a durable `Memory`, write storage, invoke MCP Memory tools, select Core, or bypass P9 grounding.

## 3.1 Resolver boundary

Introduce a small provider-neutral resolver/factory conceptually equivalent to:

```ts
interface SemanticModelResolutionContext {
  sessionProvider?: string;
  cwd?: string;
}

interface SemanticModelResolver {
  resolve(
    config: SemanticModelConfiguration,
    context: SemanticModelResolutionContext
  ): Promise<SemanticModelResolution>;
}

type SemanticModelResolution =
  | {
      available: true;
      model: SemanticExtractionModel;
      backend: "external" | "local" | "host-agent";
      adapter: string;
    }
  | {
      available: false;
      reason: SemanticModelUnavailableReason;
    };
```

Exact TypeScript naming is implementation-owned. The separation is normative.

The resolver may select an adapter from trusted configuration and runtime capability. It MUST NOT inspect Memory content to decide the backend.

---

# 4. Configuration contract

P9 keeps semantic extraction independently opt-in.

Missing `semanticExtraction` still means:

```text
effective semantic extraction = off
```

When enabled, `semanticExtraction.model` becomes a discriminated backend configuration.

Recommended union:

```ts
type SemanticModelConfiguration =
  | HostAgentSemanticModelConfiguration
  | LocalSemanticModelConfiguration
  | ExternalSemanticModelConfiguration;

interface HostAgentSemanticModelConfiguration {
  backend: "host-agent";
  provider: "auto" | "claude-code" | "codex";
}

interface LocalSemanticModelConfiguration {
  backend: "local";
  adapter: "ollama" | "lm-studio";
  model: string;
  baseUrl?: string;
}

interface ExternalSemanticModelConfiguration {
  backend: "external";
  adapter: "openai-compatible";
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
}
```

The exact set of shipped local adapters may be staged; the config parser MUST reject an adapter that the current build does not support rather than silently reinterpret it.

## 4.1 Host-agent example

```json
{
  "semanticExtraction": {
    "mode": "grounded",
    "model": {
      "backend": "host-agent",
      "provider": "auto"
    },
    "timeoutMs": 8000
  }
}
```

`provider: "auto"` means:

```text
use the current persisted Session provider
ONLY IF that provider has a reviewed host-agent semantic adapter
AND the runtime capability gate passes
```

It does **not** mean “try arbitrary installed providers until one works.”

For example, if the current Session is Codex and Codex host-agent semantic execution is unavailable:

```text
semantic extraction for this trigger = unavailable/fail-open
```

The resolver MUST NOT silently switch to Claude Code, Ollama, or an external endpoint.

Explicit cross-provider selection is allowed:

```json
{
  "backend": "host-agent",
  "provider": "claude-code"
}
```

This permits a Codex coding Session to use an explicitly chosen Claude Code host adapter for semantic extraction, subject to capability checks.

## 4.2 Local example

```json
{
  "semanticExtraction": {
    "mode": "grounded",
    "model": {
      "backend": "local",
      "adapter": "ollama",
      "model": "qwen3:4b"
    }
  }
}
```

A local backend means the model transport stays on a configured loopback/local runtime. It does not mean Memory Space bundles the model weights.

P9 MUST NOT add multi-gigabyte model assets to the npm package.

## 4.3 External example

```json
{
  "semanticExtraction": {
    "mode": "grounded",
    "model": {
      "backend": "external",
      "adapter": "openai-compatible",
      "baseUrl": "https://example-model-endpoint/v1",
      "model": "configured-model",
      "apiKeyEnv": "MEMORY_SPACE_SEMANTIC_API_KEY"
    }
  }
}
```

Credential values MUST NOT be stored in `.memory-space/config.json`.

Allowed configuration stores only the environment-variable name or another separately reviewed credential reference.

Forbidden:

```json
{
  "apiKey": "sk-..."
}
```

## 4.4 No implicit fallback chain in v1

P9 backend v1 MUST NOT support a hidden automatic sequence such as:

```text
host-agent fails
→ try local
→ try external
```

Reasons:

- backends have different cost semantics;
- backends have different data-disclosure boundaries;
- a provider CLI may consume subscription quota;
- an external endpoint may transmit conversation evidence off-device;
- silent switching would make user consent and debugging ambiguous.

A future explicit `fallbacks: [...]` configuration may be separately reviewed. It is out of scope here.

---

# 5. User setup experience

Users SHOULD be able to configure semantic extraction without manually editing JSON.

Add a CLI setup flow conceptually named:

```text
memory-space semantic setup [project]
```

Exact command wiring may follow the existing CLI architecture, but the product behavior below is normative.

## 5.1 Interactive setup

When running in an interactive TTY, show choices equivalent to:

```text
Semantic memory extraction

Choose a model source:

1. Use an installed coding agent
   No additional model API key
   Uses the selected coding-agent account/quota

2. Use a local model
   No model API key
   Requires a supported local runtime/model

3. Use an external model API
   Uses an OpenAI-compatible endpoint

4. Disable semantic extraction
```

The wording MUST NOT describe `host-agent` as “free.” It may consume the user's existing coding-agent quota/subscription allowance.

The wording MUST distinguish “no additional API key” from “no cost.”

## 5.2 Detection before selection

Setup MAY detect capabilities and present them to the user:

```text
Claude Code CLI       detected
Codex CLI             detected
Ollama                 detected
External endpoint      not configured
```

Detection is informational. It MUST NOT commit a backend choice without explicit user selection.

## 5.3 Local model discovery

For supported local adapters, setup MAY query the configured/default loopback runtime and list installed models.

Example:

```text
Ollama detected

Available models:
  qwen3:4b
  llama3.2:3b
  gemma3:4b
```

P9 v1 MUST NOT scan arbitrary LAN hosts for model services.

Default discovery is loopback-only unless the user explicitly supplies another endpoint.

## 5.4 Non-interactive setup

CI/scripts MUST have a non-interactive path. Recommended shape:

```text
memory-space semantic setup PROJECT --backend host-agent --provider claude-code
memory-space semantic setup PROJECT --backend local --adapter ollama --model qwen3:4b
memory-space semantic setup PROJECT --backend external --adapter openai-compatible --base-url ... --model ... --api-key-env ...
memory-space semantic setup PROJECT --off
```

Exact flags may follow repository CLI conventions, but equivalent deterministic automation MUST exist.

## 5.5 Atomic config update

Setup MUST use the existing safe project-binding write principles:

- preserve `version` and `spaceId`;
- preserve unrelated P7/P8 configuration;
- atomically replace the config file;
- refuse unsafe symlink/non-file targets according to existing binding rules;
- never print or persist secret values;
- support a preview/dry-run if consistent with current CLI conventions.

---

# 6. External backend

The external backend is the reference network implementation.

## 6.1 Adapter

Ship an adapter behind `SemanticExtractionModel` for OpenAI-compatible structured JSON HTTP.

Preferred implementation direction:

```text
Node built-in fetch
+ AbortController timeout
+ strict response size bound
+ JSON/schema validation
```

Do not introduce a provider SDK dependency into Memory Core solely for P9.

## 6.2 Endpoint authority

`baseUrl` is user configuration, not Space identity.

The adapter MUST NOT derive a remote endpoint from repository content, model output, user conversation text, or recalled Memory.

## 6.3 Credential behavior

If `apiKeyEnv` is configured but the environment variable is missing:

```text
backend unavailable = missing_credential
```

Do not prompt for or persist the raw key from a provider lifecycle hook.

## 6.4 Network failure

Timeout, DNS, HTTP error, malformed response, invalid JSON, or schema violation follow the P9 fail-open/fail-closed split:

```text
assistant-turn implicit remember
  semantic branch fails
  deterministic extraction may still commit
  provider response remains successful

checkpoint
  follow P9 checkpoint failure semantics
  do not pretend semantic extraction succeeded
```

---

# 7. Local backend

The local backend provides a no-model-API-key path.

## 7.1 First reference adapter

P9 SHOULD implement Ollama first because it provides a simple local model runtime boundary.

A second local adapter such as LM Studio may be added through the same port after the first adapter is stable.

This document does not require bundling or automatically installing Ollama.

## 7.2 Local transport

Default local endpoints MUST be loopback.

For example, an Ollama adapter may use its normal loopback HTTP API. Exact protocol details belong in the adapter and tests, not Memory domain code.

If the user explicitly configures a non-loopback endpoint under the `local` backend, implementation SHOULD either reject it or require the user to classify it as `external`; do not silently treat a remote host as local/private.

## 7.3 Model availability

If the configured model is not installed/available:

```text
semantic backend unavailable = model_not_found
```

P9 MUST NOT silently download multi-gigabyte model weights during an assistant Stop.

A future explicit setup command may offer to install/pull a model after user confirmation. It is not required by this spec.

## 7.4 Quality gate applies equally

A local model is not trusted more because it runs on-device.

It must pass the same:

- strict structured output;
- evidence quote grounding;
- direct-user assertion requirement;
- speculative/transient/secret rejection;
- P8 Indexed-only admission;
- quality evaluation thresholds.

---

# 8. Host-agent backend

The host-agent backend is the zero-additional-model-API configuration path when the user already has a supported coding-agent CLI/account.

It is also the highest-risk backend operationally because spawning a coding agent from a lifecycle hook can recurse into Memory Space again.

Therefore host-agent support is **capability-gated**, not assumed.

## 8.1 Separation from lifecycle provider adapter

Do not make the existing provider lifecycle adapter itself act as the semantic model.

Required structure:

```text
Claude/Codex lifecycle adapter
  normalizes Session lifecycle

separate from

Claude/Codex host semantic adapter
  performs one isolated semantic inference
```

Both may contain provider-specific code, but they implement different ports and responsibilities.

## 8.2 Isolation requirements

One host-agent semantic invocation MUST run as an isolated child execution with all practical controls available for that provider.

Required target properties:

```text
non-interactive / one-shot execution
bounded semantic prompt only
no Memory Space MCP tools
no Memory Space lifecycle hooks
no project tool execution
no autonomous repository exploration
no inherited project Memory bootstrap/recall
isolated working directory where practical
bounded timeout
captured structured output only
```

If the real provider CLI cannot satisfy a safe enough subset to prevent recursive lifecycle behavior and uncontrolled agent work:

```text
host-agent adapter for that provider = unsupported/BLOCKED
```

Do not emulate success through a normal interactive coding Session.

## 8.3 Recursion prevention

Primary prevention SHOULD be provider-native isolation: launch the semantic child so Memory Space hooks/MCP are not loaded at all.

A secondary trusted process marker MUST also exist as defense in depth, conceptually:

```text
MEMORY_SPACE_INTERNAL_INVOCATION=semantic-extraction
```

Memory Space hook entrypoints SHOULD detect the marker and return a no-op without:

- creating/resolving a Memory Session;
- persisting SessionEvents;
- performing P7 recall;
- performing P8/P9 remember;
- checkpointing;
- invoking another semantic child.

The marker is a recursion-control mechanism, not a security/authentication boundary.

Tests MUST cover accidental recursive invocation.

## 8.4 Isolated cwd

Host semantic inference SHOULD run outside the bound project directory when the provider supports it, using a temporary controlled working directory containing no project binding.

Reason:

```text
semantic child should see only the bounded events provided in its extraction prompt
not the repository or project instructions as an implicit information source
```

Even with isolation, model output remains untrusted and must be grounded against original SessionEvents.

## 8.5 Tool access

If a provider's non-interactive mode allows disabling tools, tools MUST be disabled for semantic extraction.

If tools cannot be disabled, the capability gate must prove the chosen invocation cannot autonomously inspect or mutate the project before the adapter is declared supported.

P9 host extraction has no need for shell, filesystem, network browsing, MCP, or git tools beyond the model transport itself.

## 8.6 Quota semantics

Host-agent setup MUST disclose:

```text
No additional model API key is required.
This may use your existing Claude Code / Codex account quota or allowance.
```

Quota exhaustion is an availability failure, not a Memory correctness failure.

The adapter must report sanitized diagnostics such as:

```text
usage_limit
not_authenticated
cli_not_found
capability_unsupported
timeout
invalid_output
```

Never fabricate PASS when a real CLI run is blocked by quota.

## 8.7 `provider: auto`

For host-agent configuration only:

```text
provider = auto
```

resolves to the persisted `Session.provider` after normal Session binding.

It MUST NOT use current cwd to reinterpret provider identity.

If the current Session provider has no host semantic adapter:

```text
semantic branch unavailable/fail-open
```

No fallback provider is chosen automatically.

---

# 9. Host-agent capability gates

A provider-specific host semantic adapter cannot be advertised as supported solely because its CLI is installed.

Each provider needs a real capability result document analogous to earlier provider gates.

Recommended artifact:

```text
docs/reports/quality/P9_HOST_AGENT_CAPABILITY.md
```

Record per provider:

```text
provider
CLI version
authenticated status when observable without exposing credentials
one-shot/non-interactive invocation support
hook/MCP isolation method
recursion-prevention evidence
tool isolation evidence
structured-output parse evidence
bounded timeout evidence
real semantic fixture result
quota/blocking state
PASS / BLOCKED / UNSUPPORTED
```

## 9.1 Gate A — isolated invocation

Required:

```text
real installed CLI
→ one semantic child invocation
→ no Memory Space lifecycle re-entry
→ no Memory MCP registration/use
→ no project mutation
→ bounded response captured
```

## 9.2 Gate B — extraction contract

Required:

```text
bounded SessionEvent fixture
→ host semantic adapter
→ schema-valid proposal
→ exact user evidence quote
→ grounding accepts candidate
```

## 9.3 Gate C — recursion regression

Required deterministic and real-process evidence that:

```text
semantic child
→ cannot trigger semantic grandchild
```

At minimum assert the child marker/hook bypass behavior in tests. Real CLI smoke SHOULD also verify no extra Memory Session/Event/receipt is created by the semantic child.

## 9.4 Advertising rule

CLI setup/status MUST show only reviewed capability truth.

Examples:

```text
Claude Code host semantic model    PASS
Codex host semantic model          BLOCKED: usage limit
```

A BLOCKED provider remains selectable only if product UX clearly warns it is unavailable, or preferably is shown but not selectable until the gate passes.

---

# 10. Resolver behavior and no-surprise policy

The resolver is deterministic from:

```text
validated project config
+ current Session provider (host-agent auto only)
+ trusted runtime capability state
```

It MUST NOT use:

- model output;
- conversation prose;
- recalled Memory;
- arbitrary environment heuristics;
- installed-provider ordering;

to choose a different backend than the user configured.

## 10.1 Resolution examples

Configured:

```json
{ "backend": "local", "adapter": "ollama", "model": "qwen3:4b" }
```

Ollama unavailable:

```text
result = unavailable/local_runtime_unreachable
no Claude/Codex/API fallback
```

Configured:

```json
{ "backend": "host-agent", "provider": "auto" }
```

Current Session:

```text
provider = codex
```

Codex capability BLOCKED:

```text
result = unavailable/capability_blocked
no Claude fallback
```

Configured:

```json
{ "backend": "external", ... }
```

Missing env credential:

```text
result = unavailable/missing_credential
no local fallback
```

---

# 11. Failure semantics

Backend failure MUST be represented separately from “model found no durable candidate.”

Conceptual result categories:

```ts
type SemanticExtractionExecutionResult =
  | { status: "ok"; candidates: unknown[] }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string };
```

Do not collapse timeout or invalid JSON into an empty successful candidate list in diagnostics.

## 11.1 Assistant Stop

For P8/P9 turn-time remember:

```text
semantic backend unavailable/failed
        ↓
record sanitized diagnostic
        ↓
retain deterministic extractor results
        ↓
normal provider flow continues
```

`RuleBasedExtractor` and project extraction rules remain usable.

## 11.2 Checkpoint

Checkpoint follows the P9 semantic checkpoint contract from the parent spec.

If semantic extraction is enabled for checkpoint and the configured backend fails in a way the parent P9 spec treats as checkpoint-significant, do not silently advance the checkpoint boundary as if semantic extraction completed.

The implementation agent MUST preserve the exact parent-spec checkpoint atomicity/failure semantics.

---

# 12. Privacy and disclosure boundaries

Backend selection changes where bounded conversation evidence is processed.

Setup/status MUST make the boundary understandable:

```text
host-agent
  evidence sent to the selected installed coding-agent CLI/service account path

local
  evidence sent to configured local runtime

external
  evidence sent to configured external HTTP endpoint
```

P9 does not introduce a general consent-management system, but explicit backend selection is required because these disclosure paths differ.

## 12.1 Data minimization

All backends receive the same P9 bounded semantic extraction input, not the full provider transcript by default.

Do not give a backend more content merely because it is local or host-agent.

## 12.2 Secrets

The existing P8 secret-like key guard is not a full DLP system.

The semantic prompt should instruct the model not to propose credentials/secrets, and deterministic P9 sensitive-evidence checks remain authoritative.

No backend adapter may log raw authorization headers, API keys, complete model responses containing rejected sensitive evidence, or unbounded Session content.

---

# 13. Doctor/status observability

Extend diagnostics so a user can answer:

```text
Is semantic extraction enabled?
Which backend did I choose?
Is that backend currently available?
Will it use an external endpoint, a local runtime, or my coding-agent quota?
```

Human output should be equivalent to:

```text
Semantic Extraction   OK       grounded
Semantic Backend      OK       host-agent / claude-code
```

or:

```text
Semantic Extraction   OK       grounded
Semantic Backend      BLOCKED  host-agent / codex / usage limit
```

or:

```text
Semantic Backend      ERROR    external / missing env MEMORY_SPACE_SEMANTIC_API_KEY
```

Machine-readable status should expose sanitized fields conceptually equivalent to:

```ts
{
  semanticExtraction: {
    configuredMode?: "off" | "grounded";
    effectiveMode: "off" | "grounded";
    backend?: "external" | "local" | "host-agent";
    adapter?: string;
    provider?: string;
    availability?: "available" | "blocked" | "unavailable" | "unknown";
    reason?: string;
  };
}
```

Never include raw API keys or authorization material.

---

# 14. Inspector observability

Inspector should remain backend-neutral for Memory semantics.

Useful P9 diagnostics MAY expose:

```text
semantic extraction attempted: yes/no
backend class: external/local/host-agent
adapter/provider name
execution status: ok/unavailable/failed
latency bucket or duration
proposal count
grounded count
rejection reason categories
```

Inspector MUST NOT display hidden model chain-of-thought.

Raw rejected sensitive evidence SHOULD NOT be persisted solely for debugging.

---

# 15. Cost and latency controls

The parent P9 one-request-per-trigger bound remains authoritative.

No backend may perform one model call per candidate/sentence.

## 15.1 No automatic retry

One assistant-turn semantic extraction attempt MUST NOT automatically retry the model.

This applies to external, local, and host-agent backends.

## 15.2 Timeout

The existing bounded semantic timeout applies uniformly. Backend-specific implementations may need smaller internal subprocess/network deadlines, but they must respect the overall configured cap.

## 15.3 Host-agent quota protection

P9 v1 does not add background semantic extraction or historical sweeps because host-agent mode could multiply user quota usage.

No timer, periodic reprocessing, or startup backfill is authorized.

---

# 16. Configuration validation

Configuration parser must use a strict discriminated union.

Reject combinations such as:

```json
{
  "backend": "local",
  "apiKeyEnv": "X"
}
```

unless that exact field is part of the reviewed local adapter contract.

Reject:

```json
{
  "backend": "external",
  "provider": "claude-code"
}
```

Reject unknown backend or adapter values.

Raw `apiKey` remains forbidden regardless of backend.

Invalid P9 backend configuration:

```text
semantic extraction fail-closed to off/unavailable
P8 deterministic remember remains independently usable
Space binding remains usable when version + spaceId are valid
status/doctor reports remediation
```

---

# 17. Composition root

The default Memory Space core should remain usable without semantic model configuration.

Recommended composition direction:

```text
create base deterministic extractor
        ↓
load validated project/session P9 configuration
        ↓
resolve configured SemanticExtractionModel when enabled
        ↓
compose SemanticMemoryExtractor additively
```

Do not make construction of `MemorySpace` itself require a network model or installed CLI.

Tests MUST be able to inject a deterministic fake `SemanticExtractionModel` without starting any provider CLI or HTTP service.

---

# 18. Required tests

In addition to the parent P9 grounding/evaluation suite, backend integration must cover at least the following.

## 18.1 Configuration

```text
missing semantic config -> off
host-agent union parses
local union parses
external union parses
unknown backend rejected
wrong fields for backend rejected
raw apiKey rejected
unrelated P7/P8 config preserved
```

## 18.2 Resolver

```text
configured backend selected deterministically
unavailable backend does not silently fallback
host-agent auto uses persisted Session.provider only
explicit host provider may differ from coding Session provider
unknown/unreviewed host provider unavailable
```

## 18.3 External adapter

```text
request is bounded
structured response parsed
missing env credential unavailable
HTTP failure sanitized
invalid JSON rejected
schema-invalid output rejected
timeout aborted
authorization material not logged
```

## 18.4 Local adapter

```text
loopback runtime success
runtime unavailable fail-open at Stop
model missing reported distinctly
no automatic model download
same grounding/admission pipeline as external
```

## 18.5 Host-agent adapter

```text
semantic child uses isolated invocation path
internal child marker bypasses lifecycle processing
child creates no Memory Session/Event/receipt
semantic child cannot recursively spawn semantic grandchild
tools/MCP/hooks are disabled or capability gate blocks provider
quota/auth/CLI errors sanitized
structured output passes normal grounding
```

## 18.6 User setup

```text
interactive selection writes selected backend only
no capability detection silently chooses backend
external setup stores apiKeyEnv name, not value
local setup records selected installed model
host-agent setup warns about existing account/quota usage
setup off disables semantic extraction without changing P8/P7 settings
atomic safe write behavior preserved
```

---

# 19. Real-runtime acceptance

P9 backend support is not complete based only on fake-model unit tests.

## 19.1 External real-model smoke

At least one real OpenAI-compatible model endpoint must pass:

```text
natural-language variant fixture
→ structured proposal
→ exact user grounding
→ Indexed persistence
```

Record endpoint class/model identifier without recording credentials.

## 19.2 No-additional-API-key smoke

Before claiming the product supports semantic extraction without an additional model API key, at least one of these must PASS in a real runtime:

```text
supported local model backend
OR
supported host-agent backend
```

If Ollama passes, Memory Space may truthfully claim a local/no-model-API-key path even while host-agent support is still gated.

Do not claim “no extra setup” merely because local mode exists; local mode may still require installation of a runtime/model.

## 19.3 Host-agent smoke

Each host provider advertised as supported needs its own capability result.

Canonical source fixture:

```text
上传组件是通过 variant 来判断是否使用新版样式的，现在 variant 一共有 a、b、c 三种。
```

Required observations:

```text
one isolated semantic child invocation
no recursive lifecycle events/materialization
schema-valid grounded proposal
Memory persisted only through normal P9/P8 path
Memory tier = Indexed
no explicit memory_remember call by child
```

If the installed CLI is blocked by account quota:

```text
provider result = BLOCKED
```

not PASS.

---

# 20. Quality metrics

Backend choice MUST NOT create separate relaxed Memory-quality thresholds.

The parent P9 semantic precision/recall and hard correctness gates remain shared.

Add backend operational metrics:

```text
Backend Unexpected Fallback Rate = 0.0
Host-Agent Recursive Invocation Rate = 0.0
Host-Agent Semantic Child Memory Mutation Rate = 0.0
Raw Credential Persistence Rate = 0.0
Backend Selection Consent Violation Rate = 0.0
```

For fixtures that can run across multiple backends, compare semantic proposal/admission behavior for gross divergence, but do not require byte-identical natural-language content from non-deterministic models.

Grounding and durable effects must remain deterministic for a given accepted proposal.

---

# 21. Updated implementation plan

This section supersedes the production-backend staging in the parent P9 `§25`.

Do not implement all provider transports before the semantic foundation is stable.

## P9.1 — Grounded semantic foundation

Deliver:

```text
SemanticExtractionModel port
SemanticMemoryExtractor
strict response schema
versioned prompt
bounded model input
deterministic grounding
direct-user evidence enforcement
fake deterministic semantic model
grounding unit/integration tests
variant natural-language fixture
```

No production HTTP/CLI adapter is required for P9.1.

## P9.2 — Conservative admission + eval

Deliver:

```text
durability/assertion gate
sensitive-evidence gate
semantic/deterministic candidate coexistence
P8 admission + receipt preservation
P7 lexical cross-Session closure fixture
precision-first semantic eval
Inspector diagnostics
```

## P9.3a — External backend

Deliver:

```text
OpenAI-compatible SemanticExtractionModel adapter
strict config union for external backend
timeout/response bounds
apiKeyEnv handling
doctor/status
real-model smoke
```

## P9.3b — Local backend

Deliver:

```text
Ollama SemanticExtractionModel adapter
local runtime/model discovery for setup
loopback/no-secret configuration
real local-model smoke
no-additional-model-API-key product proof
```

LM Studio is optional after Ollama unless independently required.

## P9.4 — Host-agent backend

Deliver provider-by-provider:

```text
host semantic adapter
isolated one-shot invocation
hook/MCP/tool isolation
recursion breaker
capability spike
real CLI smoke
quota/auth diagnostics
setup integration
```

Claude Code and Codex MUST be evaluated independently. One provider PASS does not imply the other.

Host-agent P9.4 MUST NOT delay P9.1/P9.2 correctness work.

## P9.5 — Setup UX hardening

After at least external + one no-additional-model-API-key backend are real-smoke validated:

```text
interactive semantic setup
non-interactive setup flags
detection display
doctor/status backend explanation
documentation for switching backends
```

Implementation may bring basic setup earlier if useful, but capability truth and no-surprise selection rules are mandatory from the first shipped backend.

---

# 22. Completion gates

P9 semantic extraction foundation may be called COMPLETE only when parent P9 correctness gates pass.

Backend claims are tracked separately.

Recommended status model:

```text
P9 semantic foundation
  COMPLETE / REVIEW PASS

external/openai-compatible
  PASS / BLOCKED / NOT RUN

local/ollama
  PASS / BLOCKED / NOT RUN

host-agent/claude-code
  PASS / BLOCKED / UNSUPPORTED / NOT RUN

host-agent/codex
  PASS / BLOCKED / UNSUPPORTED / NOT RUN
```

To advertise both product choices requested by this amendment:

```text
“Use an external API”
  -> requires external backend PASS

“Use semantic extraction without configuring an additional model API key”
  -> requires local OR host-agent backend PASS
```

To advertise:

```text
“Use your current coding-agent account directly”
```

requires the corresponding host-agent provider PASS. Local-model PASS does not satisfy that stronger claim.

---

# 23. Forbidden shortcuts

Implementation MUST NOT:

1. let the semantic model call `memory_remember` directly;
2. let a backend return final Memory rows;
3. silently switch to another backend after failure;
4. silently send evidence to an external endpoint because a local/host backend failed;
5. store raw API keys in project config or logs;
6. treat “CLI installed” as host-agent capability PASS;
7. run a normal fully tooled coding-agent Session as the semantic child;
8. permit a semantic child to recursively trigger Memory Space lifecycle hooks;
9. bundle large model weights into the npm package;
10. download a model during Assistant Stop;
11. weaken P9 evidence grounding for a supposedly trusted backend;
12. add new MCP tools for backend selection;
13. alter P7/P8 Core/Indexed/checkpoint semantics to simplify model integration;
14. claim Claude/Codex host-agent PASS when real CLI evidence is blocked by quota/auth/capability;
15. implement hidden backend fallback without a separately reviewed user-consent contract.

---

# 24. Agent implementation instructions

Before coding, the implementation Agent MUST read at least:

```text
docs/specs/P9_SEMANTIC_EXTRACTION_SPEC.md
docs/specs/P9_SEMANTIC_MODEL_BACKENDS_SPEC.md
docs/specs/P8_IMPLICIT_REMEMBER_SPEC.md
docs/specs/PROVIDER_INTEGRATION_SPEC.md
src/ports/extractor.ts
src/adapters/declarative-rule-extractor.ts
src/adapters/rule-based-extractor.ts
src/integration/implicit-remember.ts
src/application/implicit-remember-admission.ts
src/binding/project-config.ts
src/binding/space-resolver.ts
src/composition.ts
existing provider hook/configure adapters and real-smoke scripts
```

Before implementation, report a short design map answering:

1. where the `SemanticExtractionModel` port belongs;
2. where backend-specific transports belong;
3. how model resolution remains separate from `MemorySpace`;
4. how project config becomes a strict discriminated union;
5. how deterministic extraction survives every semantic backend failure;
6. how host semantic child recursion is prevented;
7. which real CLI capability must be proved before Claude/Codex host support is claimed;
8. how user selection prevents silent cost/privacy backend changes;
9. which backend phase is being implemented now and which remain out of scope.

Then implement in the P9.1 → P9.2 → P9.3a → P9.3b → P9.4 order unless a documented dependency requires a smaller rearrangement.

Do not opportunistically implement semantic identity, embeddings, semantic recall, a second verifier, durable privacy watermark, or unrelated provider refactors.

---

# 25. Validation checklist

For every implementation phase, run the repository's actual equivalent of:

```text
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run inspector:build
pnpm run check
pnpm run check:workspace
git diff --check
```

Also run the P9 semantic eval once it exists.

Production backend phases must add their relevant self-test/real-smoke command rather than overloading old P7/P8 smoke results.

Record actual CLI/model versions and actual PASS/BLOCKED state. Do not synthesize provider evidence.

---

# 26. Final acceptance examples

## External choice

User selects:

```text
external / openai-compatible
```

Then ordinary conversation:

```text
上传组件是通过 variant 来判断是否使用新版样式的，现在 variant 一共有 a、b、c 三种。
```

Required:

```text
one bounded external semantic request
→ grounded proposal
→ P8 admission
→ Indexed Memory
```

No raw API credential is stored.

## Local choice

User selects:

```text
local / ollama / configured model
```

Required:

```text
no model API credential
one bounded loopback semantic request
same grounding/admission
Indexed Memory
```

## Host-agent choice

User selects:

```text
host-agent / claude-code
```

only after Claude host capability PASS.

Required:

```text
normal Claude coding Session Stop
        ↓
Memory Space semantic extraction
        ↓
one isolated Claude semantic child
        ↓
NO child Memory Space lifecycle/MCP recursion
        ↓
structured grounded proposal
        ↓
normal P9/P8 admission
        ↓
Indexed Memory
```

The child model never owns the durable write.

---

# 27. Frozen summary

P9 backend architecture is:

```text
                           USER CHOICE
                               │
             ┌─────────────────┼──────────────────┐
             ▼                 ▼                  ▼
         external            local            host-agent
       user's API       user's local model   user's installed
                                                coding agent
             │                 │                  │
             └─────────────────┴──────────────────┘
                               ↓
                    SemanticExtractionModel
                               ↓
                    SemanticMemoryExtractor
                               ↓
                 deterministic grounding/policy
                               ↓
                      existing P8 admission
                               ↓
                           Indexed
```

The model source is replaceable. The Memory trust boundary is not.
