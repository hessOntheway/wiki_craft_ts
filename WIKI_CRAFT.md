# Wiki Craft Schema

This file is the operating contract for approved knowledge used by Wiki Craft search and authoring.

## Knowledge Base Location

AI coding tools should read approved knowledge from:

- `.wiki_craft/knowledge_bases/{id}/knowledge/approved/index.md`
- `.wiki_craft/knowledge_bases/{id}/knowledge/approved/topics/*.md`
- `.wiki_craft/knowledge_bases/{id}/knowledge/approved/evidence/source_summaries/`

## Rules

- Treat approved Markdown as authoritative for the selected knowledge base.
- Local imports are considered user-approved evidence and are written directly under approved evidence.
- Prefer concise Markdown pages with links back to source URLs when available.
- Mark conflicts, uncertainty, and changed claims explicitly.

## Approved Topic Authoring Contract

Use this frontmatter shape for topic and evidence-summary Markdown:

```yaml
---
title: "<stable topic name>"
aliases: []
tags: []
source_ids: []
source_urls: []
version_hashes: []
---
```

Recommended topic sections:

```md
# <stable topic name>

## Summary

## Business Context

## Code/Workflow Map

## Review Guidance

## Relations

## Evidence

## Conflicts & Uncertainties
```

Chunk quality rules:

- Keep one page focused on one stable topic, workflow, business rule, integration, or review risk.
- Avoid long mixed reports; split unrelated concepts into separate topic pages.
- Put important searchable concepts in headings, tags, aliases, wikilinks, or concise paragraphs.
- Preserve code evidence as file paths, symbols, endpoints, config keys, source URLs, or version notes.
- Tags are authored or normalized before indexing; reindex does not infer new tags.
