---
schema: 1
name: feature
kind: template
title: Feature (for a code implementer)
description: A backlog item body for a feature. Says what it is for before what to build, so the plan can push back.
---
## The problem

{{who_needs_it_and_why}}

## What to build

{{what_it_does}}

- In scope: {{in_scope}}
- Out of scope: {{out_of_scope}}

## Done means

- {{observable_outcome}}
- Tests cover the new behaviour and the edge that is most likely to break: {{riskiest_edge}}
- Anything a user would need explained is documented where the project documents such things.
