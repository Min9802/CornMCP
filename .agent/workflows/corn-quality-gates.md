---
description: MANDATORY Corn Hub quality gates and MCP tool usage for EVERY task
---

# 🌽 Corn Hub — Mandatory Quality Gates

This workflow is **COMPULSORY** for every single task. No exceptions. Every step must be followed in order.

## Phase 0: Session Start (BEFORE any work)

// turbo-all

1. Call `corn_tool_stats` to display live analytics in the chat
2. Call `corn_changes` to check for recent code changes from other agents
3. Call `corn_session_start` with the project name and a brief task summary
4. Call `corn_memory_search` with a query related to the current task to recall past context
5. Call `corn_knowledge_search` with a query related to the current task to find existing patterns/decisions

## Phase 1: Planning (BEFORE any code changes)

6. Create the implementation plan
7. Call `corn_plan_quality` with the FULL plan text — **plan MUST score ≥80% to proceed**
   - If score < 80%: STOP. Revise the plan addressing every ❌ criterion. Resubmit until it passes.
   - If score ≥ 80%: Proceed to execution.
8. Store the approved plan with `corn_memory_store` for future reference

## Phase 2: Execution

9. Execute the approved plan
10. For any code changes, call `corn_code_search` to find related code patterns first
11. Call `corn_detect_changes` periodically to assess risk of uncommitted changes

## Phase 3: Quality Report (AFTER all work is done)

12. Call `corn_quality_report` with 4D scoring:
    - `scoreBuild` (0-25): Does the code compile/build?
    - `scoreRegression` (0-25): Were existing features broken?
    - `scoreStandards` (0-25): Does it follow project conventions?
    - `scoreTraceability` (0-25): Can the changes be traced back to the task?
    - **Total MUST be ≥60/100 to pass**

## Phase 4: Session End

13. Call `corn_knowledge_store` if any reusable patterns, decisions, or bug fixes were discovered
14. Call `corn_memory_store` with a summary of what was accomplished
15. Call `corn_session_end` with:
    - Summary of what was done
    - Files changed
    - Key decisions made
    - Any remaining blockers
16. Call `corn_tool_stats` one final time to show updated analytics

## Rules

- **NEVER skip any phase.** Every phase is mandatory.
- **NEVER execute a plan that scored below 80%** on `corn_plan_quality`.
- **NEVER end a task without submitting a `corn_quality_report`.**
- **ALWAYS call `corn_tool_stats` at the START of every response** so the user sees live analytics.
- If a quality report scores below 60/100, you MUST fix the issues before ending the session.
