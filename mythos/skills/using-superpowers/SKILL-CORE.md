# using-superpowers (essence)

How to decide a skill applies, and what to do once it does.

## The rule

Check for a relevant skill BEFORE responding or acting — including before
asking a clarifying question. If there is even a small chance a skill applies,
load it with `use_skill`. If it turns out to be the wrong fit, drop it; the
cost of checking is far below the cost of unguided work.

## Order of precedence

1. The operator's explicit instructions win over everything.
2. Skill guidance overrides default behaviour where they conflict.
3. Default behaviour is the floor.

## Sequence

1. Load the skill.
2. Say which skill is being applied and why.
3. If it carries a checklist, turn each item into a tracked task.
4. Follow it exactly — rigid skills (TDD, debugging, verification) are not to
   be adapted away; pattern skills are.

## Process before implementation

When several skills apply, process skills come first because they decide HOW
the work is approached:

- "build X" → brainstorming, then the implementation skill
- "fix bug Y" → systematic-debugging, then the domain skill

## Rationalizations that mean stop

"This is simple." "I need context first." "Let me just look at the code."
"I remember this skill." "The skill is overkill." Each of these is the sound
of skipping the check. Check first, then act.
