# Subagent Delegation

This context describes delegated work and the information shown to the user during that work.

## Language

**Main session**:
The conversation in which the user and the coordinating agent work together.
_Avoid_: Parent chat

**Subagent session**:
A separate agent conversation for delegated work. It can continue across several runs.
_Avoid_: Worker run

**Run**:
One attempt to complete an assigned task in a subagent session, ending in completion, failure, or cancellation.
_Avoid_: Session, turn

**Worker**:
The visible representation of a subagent session and its current or most recent run.
_Avoid_: Background agent

**Session cost**:
The accumulated reported model cost for a subagent session, including earlier runs.
_Avoid_: Run cost

**Run cost**:
The reported model cost incurred during one run.
_Avoid_: Session cost

**Running cost sum**:
The sum of session costs for subagent sessions that currently have an active run. It excludes the main session and subagent sessions with no active run.
_Avoid_: Total session cost
