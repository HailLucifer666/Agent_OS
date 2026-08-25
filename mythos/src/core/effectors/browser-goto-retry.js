'use strict';

// BUG-339 (2026-08-24): redirect-heavy sites abort the commit-phase goto once
// (news.google.com measured in vault/Audit/2026-08-09.jsonl L52-L64: four
// ERR_ABORTED calls in 26s, manual retry succeeded ~25s later). One bounded
// retry replaces the model having to be the retry logic. Extracted from
// from-browser.js (file-size-ratchet ceiling) as a pure page-injected helper.

const GOTO_RETRY_DELAY_MS = 750;

async function gotoWithRedirectRetry(page, target) {
  try {
    await page.goto(target, { waitUntil: 'commit' });
    return;
  } catch (err) {
    if (!/net::ERR_ABORTED/.test(String(err && err.message))) throw err;
  }
  await new Promise((resolve) => setTimeout(resolve, GOTO_RETRY_DELAY_MS));
  await page.goto(target, { waitUntil: 'commit' });
}

module.exports = {
  gotoWithRedirectRetry: gotoWithRedirectRetry,
  GOTO_RETRY_DELAY_MS: GOTO_RETRY_DELAY_MS,
};
