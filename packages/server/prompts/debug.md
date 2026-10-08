---
schema: 1
name: debug
kind: template
title: Debug a bug (hypotheses first, instrumentation cleaned up)
description: A backlog item body for a bug whose cause is not known yet. Hypotheses are stated before any change, probes live only inside marked blocks, and planestro refuses report_done while one remains.
---
## The bug

{{what_happens}}

- Expected: {{what_should_happen}}
- How to reproduce: {{how_to_reproduce}}

## How to work it

1. **Hypotheses first.** Before changing anything, write down each plausible cause, what evidence would confirm or rule it out, and which you will test first. Put them in the plan; while implementing, add a note (`add_note`) when one is ruled out or confirmed, and why.
2. **Reproduce it.** Prefer an automated test that fails on the current code; it stays as the regression test once the bug is fixed.
3. **Instrument only inside marked blocks.** Every temporary probe (logging, prints, assertions, timers, debug flags) goes between a `planestro:debug-begin` line and a `planestro:debug-end` line, written as comments in the file's own syntax:

   ```
   // planestro:debug-begin
   console.log('cart total before discount', total);
   // planestro:debug-end
   ```

   (`# planestro:debug-begin` in Python or shell, `<!-- planestro:debug-begin -->` in HTML, `-- planestro:debug-begin` in SQL.) Nothing temporary goes anywhere else.
4. **Fix the cause, not the symptom.** Name the confirmed cause in the commit message and in your report.
5. **Remove every marked block before `report_done`**: both markers and everything between them, keeping the fix and its test. planestro refuses `report_done` while your branch still adds a line with either marker, and names each file and line; remove them, commit, and call it again.
