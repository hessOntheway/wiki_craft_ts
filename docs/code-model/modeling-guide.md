# Three-Layer Code Model Guide

## Purpose

This guide defines the required Markdown structure for the Wiki Craft code-model knowledge base. Agents that author or update code-model pages must follow this format exactly because the search and graph indexes parse these headings and field labels.

The model has two audiences:

- Humans who need a readable map of backend behavior.
- AI code-review agents that need fast business and API context before searching source code directly.

Current scope: `backend/src/**` only. Frontend and Tauri shell code are outside this model unless a maintainer explicitly expands the scope.

## Hard Format Rules

- Do not add YAML frontmatter to index, L1, L2, or L3 code-model pages.
- Create exactly one code-model `index.md` page when authoring a complete model. Do not create other `index.md` pages.
- Keep the first line as the H1 title.
- Use the exact required headings and field labels in this guide.
- Do not rename required fields such as `Business goal`, `Business context`, `Business rules`, `Business constraints`, `Expected outcome`, `Calls L3`, `Entry parameters`, `Drill down to L2`, `Parameters`, or `Returns`.
- Do not add duplicate relation sections such as `Relations` or `Graph Triples`.

## Language Rule

All generated wiki pages must be written in English, including titles, summaries, headings, field values, business rules, constraints, outcomes, and parameter explanations. Keep code identifiers, API paths, event names, config keys, and quoted source terms exactly as they appear in the code.

## Mandatory Layering Gate

Do not deliver a new code-model with only one model layer. For a new or empty model, the first delivery must include at least:

- one project index page
- one L1 page
- one L2 page
- one L3 page

If any layer is missing, keep analyzing and add the missing pages before considering the update complete.

Recommended starter file set:

- `index.md`
- `l1-backend-capabilities.md`
- `l2-entrypoints.md`
- `l3-<module-name>-module.md`

## Project Coverage Gate

Do not treat one business slice as a complete project model. Before authoring, scan the project entrypoint surface and use it to decide the required L1/L2/L3 pages.

For backend services, inspect these entrypoint families when present:

- HTTP servers and route registration, such as `cmd/server`
- Kafka/event consumers, such as `cmd/consumer` or `cmd/*consumer`
- CLI or scheduled jobs, such as `cmd/*cli` or cron job registries
- Other stable externally-triggered entrypoints

Completion requires:

- The project index briefly explains what the project does and is not treated as searchable review knowledge.
- L1 covers every major business capability exposed by the scanned entrypoints.
- L2 covers every discovered entrypoint family, not just one endpoint group.
- L3 covers the main service/module APIs called by those L2 entrypoints.

If only part of the project is intentionally modeled, add a `Partial coverage:` note in the L1 Summary and name the included and excluded entrypoint families.

## Business Semantics Rules

Code-model pages should capture durable business meaning, not just technical shape. Prefer business language over implementation details.

- Use `Business goal` for the business outcome the capability or interface exists to support.
- Use `Business context` for who or what business process depends on the behavior.
- Use `Business rules` for stable must/forbidden conditions that reviewers or downstream users need to preserve.
- Use `Business constraints` for business boundaries, eligibility limits, and scope restrictions.
- Use `Expected outcome` for the business-visible result when the behavior succeeds.
- For interface `Entry parameters`, explain each parameter's source, whether it is required, business meaning, and any business-relevant accepted values, defaults, or validation.

## Core Shape

The model has one orientation page plus three indexed model layers:

| Layer | Page family | Question it answers |
| --- | --- | --- |
| Index | project orientation page | What is this project, in plain language, before searching detailed model chunks? |
| L1 | backend/repo capability pages | What does the backend do, and which L2 interfaces expose each capability? |
| L2 | interface entrypoint pages | What external entrypoints exist, what business goal do they expose, and what L3 methods do they call? |
| L3 | module/class/function pages | What public or exported code surfaces exist, and what are their responsibilities? |

Build and maintain the model from factual details into project orientation:

1. Inspect L3 exported module APIs, public classes, and important callable surfaces.
2. Group those surfaces into L2 interface entrypoints.
3. Summarize the L2 behavior into L1 backend capabilities.
4. Write or refresh `index.md` as a short project orientation page.

## Index: Project Orientation Page

`index.md` is a short, direct introduction to what the project does. It is for agents that need to understand the project before deciding what to search.

Required index format:

```md
# <Project Name>

## Summary

<one to three short paragraphs explaining what the project does, who uses it, and what backend scope the code model covers>
```

Required index keywords:

- `## Summary`

Index rules:

- Keep the page short and project-level.
- Do not include L1/L2/L3 relation fields.
- Do not add `Drill down to L2`, `Calls L3`, `Relations`, or `Graph Triples`.
- The search index must exclude `topics/code-model/index.md`; generated skills should read it directly before searching when project orientation is needed.

## L3: Module And Object API Layer

Start with L3 whenever source code changes. This layer is the factual base of the model.

Include:

- Exported functions.
- Exported classes and public methods.
- Important internal classes when they act like a stable object boundary.
- Modules whose exported methods represent stable business behavior or review-relevant system behavior.

Do not include:

- Every private helper.
- One-off local variables.
- Pure type/interface files when they only define data shapes.
- Utility-only modules whose exports are generic helpers rather than business behavior.
- Implementation details that do not help explain entrypoints, ownership, resources, or review impact.

Required L3 format:

```md
# <Module Or Object API>

## Summary

## Exported API

### `functionName(signature)`

- Business responsibility:
- Business rules:
  - <business rule>
- Business constraints:
  - <business constraint>
- Expected outcome:
- Parameters:
  - `parameterName`: <business meaning>
- Returns:
```

Required L3 keywords:

- `## Summary`
- `## Exported API`
- `- Business responsibility:`
- `- Business rules:`
- `- Business constraints:`
- `- Expected outcome:`
- `- Parameters:`
- `- Returns:`

For retrieval chunking, keep each exported method's signature, business responsibility, parameters, and return shape close together. Avoid separating one large API table from a second large parameter table.

## L2: Interface Entrypoint Layer

Build L2 after L3 is accurate. Treat HTTP endpoints, CLI commands, gRPC methods, Kafka consumers, scheduled jobs, and other stable external entrypoints as interfaces.

Required L2 format:

```md
# <Interface Family Title>

## Summary

## Endpoints

### <INTERFACE NAME>

- Business goal:
- Business rules:
  - <business rule>
- Business constraints:
  - <business constraint>
- Expected outcome:
- Entry parameters:
  - `<name>` (`header|path|query|body|event|command`, required|optional): <business meaning; accepted values/defaults/validation when business-relevant>
- Calls L3:
  - `module.method(signature)`
```

Use the exact interface-family heading that matches the page:

- `## Endpoints`
- `## Commands`
- `## gRPC Methods`
- `## Kafka Consumers`

Required L2 keywords:

- `## Summary`
- one exact interface-family heading, such as `## Endpoints` or `## Commands`
- `- Business goal:`
- `- Business rules:`
- `- Business constraints:`
- `- Expected outcome:`
- `- Entry parameters:`
- `- Calls L3:`

For graph retrieval, do not hand-author `Graph Triples`. The graph index is derived from each interface subsection title and its `Calls L3` list.

## L1: Backend Capability Layer

Build L1 last. L1 is a compact project-level abstraction and must route readers only to L2 pages. L1 must not directly point to L3 methods or source modules.

Required L1 format:

```md
# <Project Or Repository Model>

## Summary

## Capabilities

### <Capability Name>

- Business goal:
- Business context:
- Business domains:
- Expected outcome:
- Drill down to L2:
  - [<L2 page title>](<l2-file.md>): <interface names>
```

Required L1 keywords:

- `## Summary`
- `## Capabilities`
- `- Business goal:`
- `- Business context:`
- `- Business domains:`
- `- Expected outcome:`
- `- Drill down to L2:`

## Graph Indexing

Do not hand-author duplicate `Relations` or `Graph Triples` sections. The graph index should be derived from structured page text:

- L1 capability sections derive capability-to-L2 navigation from `Drill down to L2`.
- L2 interface sections derive interface-to-L3 edges from `Calls L3`.
- L3 pages are terminal exported API descriptions and do not maintain graph edges.

## Page Naming

Use stable, readable filenames:

- `index.md`
- `l1-<domain>.md`
- `l2-<entrypoint-family>.md`
- `l3-<module-name>-module.md`

Use stable, readable page titles:

- `# <Project Name>`
- `# Backend Repository Model`
- `# Backend HTTP Endpoints`
- `# Runtime Module API`

## Forbidden Sections

Do not include these sections in generated code-model pages:

- `## Relations`
- `## Evidence`
- `## Review Notes`
- `## Important Internal Flow`
- `## Graph Triples`

## Maintenance Workflow

When backend code changes:

1. Update affected L3 module pages first.
2. If exported functions/classes changed, update the matching per-export subsections.
3. If exported signatures changed, keep parameters next to the affected function/method.
4. If behavior or resources changed, update the affected function/method business responsibility, parameters, or return shape.
5. If a route, command, gRPC method, Kafka consumer, or other interface changed, update L2 pages.
6. If a capability boundary changed, update L1.
7. Keep summaries human-readable and compact.
8. Verify the generated `code-model/` directory contains only current `index.md` and L1/L2/L3 pages.

When adding a new backend module:

1. Create a new L3 page only if the module has review-relevant exported behavior.
2. Document exported APIs and core parameters together before writing higher-layer summaries.
3. Add or update L2/L1 routing only if the module changes an interface or capability boundary.

When adding a new interface:

1. Add a new interface subsection to the relevant L2 page.
2. Document its business goal and entry parameters.
3. Add called L3 functions or methods under `Calls L3`.
4. Add or update L1 capability drill-downs if this creates or changes a capability.

## Minimal Update Checklist

Before finishing a model update:

- The changed page follows the exact index, L1, L2, or L3 format.
- Required headings and field labels are spelled exactly as shown in this guide.
- L3 pages keep exported APIs, core parameters, and return shape together per method.
- L2 pages keep each interface's business goal, entry parameters, and `Calls L3` together.
- L1 pages drill down only to L2.
- `index.md` exists for project orientation and is excluded from search indexing.
- The generated `code-model/` directory contains no stale or duplicate model pages.
