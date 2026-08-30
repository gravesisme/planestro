---
schema: 1
name: audit-recent-code
kind: template
title: Audit recent code
description: A backlog item body for reviewing what landed recently.
---
Do a thorough review of this repo and look for any critical performance issues and/or bugs, because a lot of new code has landed recently (`git log --since="{{since}}"`). As part of this audit, look for gaps, hardening, performance issues, bugs, optimizations, and enhancements that will improve it.
