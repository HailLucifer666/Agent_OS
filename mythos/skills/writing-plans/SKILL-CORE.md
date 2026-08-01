# writing-plans (essence)

Write the plan for an engineer who is skilled but has zero context for this
codebase and no knowledge of its toolset.

## What the plan must contain

- **Header**: goal in one sentence, architecture in two or three, the tech
  stack, and a pointer to the skill that will execute it.
- **File structure first**: which files get created or modified and what each
  is responsible for. Decomposition decisions get locked in here, not
  improvised mid-build. One clear responsibility per file; files that change
  together live together; split by responsibility, not by technical layer.
- **Bite-sized steps**, each one action of two to five minutes:
  write the failing test / run it and watch it fail / write the minimal code /
  run the tests / commit. Checkbox syntax so progress is trackable.
- **Verification per step** — the command that proves the step worked, not a
  description of what should happen.

## Scope check

If the spec spans independent subsystems, split it into one plan per
subsystem. Each plan must produce working, testable software on its own.

## In an existing codebase

Follow the established patterns. Do not unilaterally restructure a codebase
because its style differs from yours; a split is only reasonable for a file
the plan already has to modify and which has grown unwieldy.

## Discipline carried into the plan

DRY. YAGNI. TDD. Frequent commits. Every step traceable to the spec.
