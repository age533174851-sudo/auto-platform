#!/usr/bin/env node
// GitHub Actions fallback response contract. Never print the response body or secrets.
// HTTP 200 means the endpoint responded; it does NOT mean a trade was entered or filled.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function tickResponseVerdict(body) {
  const fail = (code) => ({ pass: false, code, scheduled: null, checked: 0, reportedEntries: 0, failures: 0 });
  if (!object(body)) return fail('INVALID_JSON_SHAPE');
  if (body.ok !== true || body.error != null || body.scheduledUnknown === true) {
    return fail('SCHEDULE_READ_OR_SERVER_FAILED');
  }
  if (!Number.isSafeInteger(body.scheduled) || body.scheduled < 0 || !Array.isArray(body.results)) {
    return fail('SCHEDULE_COUNT_UNKNOWN');
  }
  if (body.results.length !== body.scheduled || !body.results.every(object)) {
    return fail('SCHEDULE_RESULT_INCOMPLETE');
  }
  const failures = body.results.filter((r) => r.ok === false).length;
  const reportedEntries = body.results.filter((r) => r.executed === true).length;
  const checked = body.results.length;
  if (failures > 0) {
    return { pass: false, code: 'EVALUATION_FAILURE', scheduled: body.scheduled, checked, reportedEntries, failures };
  }
  if (body.scheduled === 0) {
    return { pass: true, code: 'NO_ENABLED_SCHEDULES', scheduled: 0, checked, reportedEntries, failures };
  }
  return { pass: true, code: reportedEntries > 0 ? 'ENTRY_REPORTED_NOT_FILL_VERIFIED' : 'NO_ENTRY_REPORTED', scheduled: body.scheduled, checked, reportedEntries, failures };
}

// This is a CLI only when run directly; importing it for tests has no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let verdict;
  try {
    const path = process.argv[2];
    if (!path) throw new Error('missing body file');
    verdict = tickResponseVerdict(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    verdict = { pass: false, code: 'INVALID_OR_MISSING_BODY', scheduled: null, checked: 0, reportedEntries: 0, failures: 0 };
  }
  // Do not print raw HTTP payload, error messages, identifiers or credentials.
  console.log('TRAIGO_TICK ' + verdict.code + ' scheduled=' + (verdict.scheduled ?? 'UNKNOWN') + ' checked=' + verdict.checked + ' entryReported=' + verdict.reportedEntries + ' failures=' + verdict.failures);
  if (verdict.code === 'NO_ENABLED_SCHEDULES') {
    console.log('NOTICE: all schedules disabled; GitHub tick succeeded but no trade was possible.');
  }
  if (verdict.code === 'ENTRY_REPORTED_NOT_FILL_VERIFIED') {
    console.log('NOTICE: entry is an application-reported result; exchange fill and SL/TP are NOT verified by this workflow.');
  }
  if (!verdict.pass) process.exitCode = 1;
}
