/**
 * The merge after parallel explorers: explorers with different focuses on
 * the same goal often meet the same defect, so once they are over one
 * structured model call groups the findings that describe the same failure,
 * and the report keeps the most detailed of each group. Nothing is ever
 * dropped: an index the model leaves out stays a finding of its own.
 */

import { z } from 'zod';
import type { ModelAdapter, ModelUsage } from '../agent/model/adapter.ts';
import { deriveJsonSchema } from '../agent/model/schema.ts';
import type { ReportExploreFinding, ReportMergedFinding } from '../report/build.ts';
import type { ProviderOptions } from '../types.ts';
import { clip } from './state.ts';

/** The merge call's deadline: one small structured call, on a slow provider. */
const MERGE_TIMEOUT_MS = 120_000;
const MERGE_OUTPUT_TOKENS = 4_096;
/** A finding's actions as the merge reads them, at most. */
const MAX_REPRODUCTION_CHARS = 400;

const MERGE_SYSTEM = `You merge the bug reports of several testers who explored the same app at the same time, each with a different focus.
Group the reports that describe the same observable failure under the same conditions:
- The same failure on the same kind of screen with different data (another user, record, item, row, or account) is one group.
- Keep separate: the same kind of defect on different kinds of screens (a list of everything versus a list inside one record, a form versus a detail screen), different symptoms, and different inputs that fail differently.
Every index appears in exactly one group; a report with no duplicate is a group of its own.`;

const MERGE_SCHEMA = z.object({
  groups: z.array(z.array(z.number().int().min(0))).describe('Groups of report indices; every index in exactly one group.'),
});

export interface MergeSettings {
  readonly adapter: ModelAdapter;
  readonly maxInputTokens: number;
  readonly providerOptions: ProviderOptions | undefined;
  readonly signal: AbortSignal;
}

export interface MergeResult {
  /** The findings with every group merged into one, numbered in order. */
  readonly findings: ReportExploreFinding[];
  readonly usage: ModelUsage;
}

/** Groups `findings` with one model call and keeps one finding per group; throws when the call fails. */
export async function mergeFindings(findings: readonly ReportExploreFinding[], settings: MergeSettings): Promise<MergeResult> {
  const reports = findings.map((finding, index) => ({
    index,
    title: finding.title,
    expected: finding.expected,
    actual: finding.actual,
    // The inputs that tell two failures apart, bounded so many findings still fit one call.
    reproduction: clip(finding.reproduction.join(' / '), MAX_REPRODUCTION_CHARS),
    ...(finding.path === undefined ? {} : { path: finding.path }),
  }));
  const { value, usage } = await settings.adapter.generate({
    system: MERGE_SYSTEM,
    prompt: `Reports:\n${JSON.stringify(reports)}\n\nRespond with {"groups": [[...], ...]}.`,
    schemaName: 'explore-merge',
    schema: await deriveJsonSchema(MERGE_SCHEMA),
    validate: (answer) => {
      const parsed = MERGE_SCHEMA.safeParse(answer);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issue: parsed.error.message };
    },
    maxOutputTokens: MERGE_OUTPUT_TOKENS,
    maxInputTokens: settings.maxInputTokens,
    providerOptions: settings.providerOptions,
    signal: settings.signal,
    timeoutMs: MERGE_TIMEOUT_MS,
  });
  return { findings: applyGroups(findings, value.groups), usage };
}

/**
 * One finding per group, in the order each group was first reported: the
 * most detailed report, graded as the gravest of its group so a merge never
 * lowers a defect, with the others in `merged`. An index out of
 * range or already grouped is ignored; one no group names stays on its own.
 */
export function applyGroups(findings: readonly ReportExploreFinding[], groups: readonly (readonly number[])[]): ReportExploreFinding[] {
  const seen = new Set<number>();
  const members: number[][] = [];
  for (const group of groups) {
    const fresh = group.filter((index) => Number.isSafeInteger(index) && index >= 0 && index < findings.length && !seen.has(index));
    for (const index of fresh) seen.add(index);
    if (fresh.length > 0) members.push(fresh);
  }
  findings.forEach((_, index) => {
    if (!seen.has(index)) members.push([index]);
  });
  return members
    .map((group) => group.toSorted((a, b) => a - b))
    .toSorted((a, b) => a[0]! - b[0]!)
    .map((group, position) => {
      const kept = group.reduce((best, index) => (detail(findings[index]!) > detail(findings[best]!) ? index : best));
      const all = group.map((index) => findings[index]!);
      const others = group.filter((index) => index !== kept).map((index) => absorbed(findings[index]!));
      const issue = all.some((finding) => finding.kind === 'issue');
      const severity = all
        .filter((finding) => !issue || finding.kind === 'issue')
        .reduce<ReportExploreFinding['severity']>((gravest, finding) => (finding.severity > gravest ? finding.severity : gravest), 1);
      return {
        ...findings[kept]!,
        index: position,
        kind: issue ? 'issue' : 'warning',
        severity,
        ...(others.length === 0 ? {} : { merged: others }),
      };
    });
}

/** What the report keeps of a finding merged into another. */
function absorbed(finding: ReportExploreFinding): ReportMergedFinding {
  return {
    id: finding.id,
    title: finding.title,
    ...(finding.explorer === undefined ? {} : { explorer: finding.explorer }),
    ...(finding.step === undefined ? {} : { step: finding.step }),
    ...(finding.artifactId === undefined ? {} : { artifactId: finding.artifactId }),
  };
}

/** How much a report tells: the characters of what it expected, saw, and did. */
function detail(finding: ReportExploreFinding): number {
  return finding.expected.length + finding.actual.length + finding.reproduction.join('').length;
}
