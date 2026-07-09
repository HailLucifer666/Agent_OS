'use strict';

// leash/audit-writer.js — DELIBERATE thin re-export, not a second audit trail.
//
// See MYTHOS-PHASE-BUILD-SPEC.md Phase 5, "Spec Ambiguities Resolved" #1: §16
// lists this file as a deliverable, but src/core/memory/audit-writer.js (P1)
// already implements the exact append-only JSONL + redaction writer Leash's
// check() needs (write/query/stats/init). This file exists only so
// `require('../leash/audit-writer')` resolves — it re-exports the memory
// module's factory unchanged. createLeash({ auditWriter }) is always called
// with memory.audit, the SAME instance the memory facade constructed — main.js
// never builds a second audit-writer instance, and vault/Audit/*.jsonl has
// exactly one writer.
module.exports = require('../memory/audit-writer');
