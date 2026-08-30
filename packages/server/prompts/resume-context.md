---
schema: 1
name: resume-context
kind: partial
role: resume_context
title: Resume context
description: Prepended when a parked session is resumed, so it knows what happened while it was stopped.
---
[planestro] Your session was parked while waiting on {{resume_reason}} and has now been resumed. Time parked: {{parked_for}}. Item {{item.id}} is in status {{item.status}}. Continue from where you left off; your worktree and branch are unchanged unless stated below.
