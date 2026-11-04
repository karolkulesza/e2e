import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type { ModelAdapter, ModelCall } from '../../src/agent/model/adapter.ts';
import { explorerFile, type ExploreSpec } from '../../src/explore/explorer.ts';
import { exploreFocuses, focusContext } from '../../src/explore/focus.ts';
import { applyGroups, mergeFindings } from '../../src/explore/merge.ts';
import { planInstruction } from '../../src/explore/plan.ts';
import { explorerOfFile, type ExploreProgress } from '../../src/explore/progress.ts';
import { ExploreRecord, type MergeFindings } from '../../src/explore/record.ts';
import { ExploreState } from '../../src/explore/state.ts';
import type { ReportExploreFinding } from '../../src/report/build.ts';

const SCHEMA_PATH = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'schema', 'report-v1.schema.json');

/** Validates one `run.explore` value against its schema definition. */
function assertValidExplore(value: unknown): void {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as { $id: string };
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/explore`);
  if (validate === undefined) throw new Error('explore definition missing from the report schema');
  if (!validate(value)) throw new Error(JSON.stringify(validate.errors, null, 2));
}

const BUDGETS = { maxSteps: 4, timeoutMs: 300_000 };

function spec(count: number): ExploreSpec {
  return {
    goal: 'Explore the tracker',
    budgets: BUDGETS,
    agentName: 'default',
    accounts: [],
    session: undefined,
    openApp: true,
    focuses: count === 1 ? [] : exploreFocuses(count, { otherAccount: false }),
  };
}

let ids = 0;
function finding(overrides: Partial<ReportExploreFinding> = {}): ReportExploreFinding {
  ids += 1;
  return {
    id: `finding-${String(ids)}`,
    index: 0,
    step: 1,
    kind: 'issue',
    severity: 3,
    title: 'Count stays at 0',
    expected: 'The count reads 1',
    actual: 'The count reads 0',
    reproduction: ['Create an issue'],
    reportedAt: '2026-11-04T10:00:00.000Z',
    ...overrides,
  };
}

/** An explorer's moments as its state would announce them: started, one step with the given findings, finished. */
function explorerRun(record: ExploreRecord, explorer: number, findings: readonly ReportExploreFinding[], focus?: string): void {
  const relay = (progress: ExploreProgress) => record.relay(explorer, progress);
  relay({ phase: 'started', goal: 'Explore the tracker', budgets: BUDGETS, ...(focus === undefined ? {} : { focus }) });
  relay({ phase: 'step-started', step: { index: 1, title: 'Issues', instruction: 'Create an issue' } });
  for (const entry of findings) relay({ phase: 'finding', finding: entry });
  relay({ phase: 'step-finished', step: { index: 1, title: 'Issues', instruction: 'Create an issue', status: 'passed', startedAt: '2026-11-04T10:00:00.000Z', durationMs: 1000 } });
  relay({ phase: 'finished', ended: 'finished', summary: `Explorer ${String(explorer)} is done.` });
}

const neverMerge: MergeFindings = () => Promise.reject(new Error('no merge expected'));
const scope = (notices: string[] = [], signal = new AbortController().signal) => ({ signal, notice: (message: string) => void notices.push(message) });

describe('explore focuses', () => {
  it('gives n explorers the first n focuses in order, and the other account only when there is one to sign in with', () => {
    expect(exploreFocuses(3, { otherAccount: false }).map((focus) => focus.label)).toEqual(['core flows', 'edge-case input', 'state across screens']);
    expect(exploreFocuses(5, { otherAccount: false }).map((focus) => focus.label)).toEqual([
      'core flows',
      'edge-case input',
      'state across screens',
      'layouts',
      'content and controls',
    ]);
    const [, , , roles] = exploreFocuses(4, { otherAccount: true });
    expect(roles).toMatchObject({ label: 'layouts and roles', text: expect.stringContaining('sign in as another of the configured accounts') });
    expect(exploreFocuses(4, { otherAccount: false })[3]!.text).not.toContain('sign in');
    expect(exploreFocuses(5, { otherAccount: false })[3]!.text).toContain('resize_viewport');
  });

  it('puts the focus beside the goal in the planner prompt, and asks every step to serve it', () => {
    const [focus] = exploreFocuses(2, { otherAccount: false });
    const focused = planInstruction(new ExploreState('Explore the tracker', BUDGETS, Date.now, focus), { mustFinish: false, remainingMs: 300_000, timeoutMs: 60_000 });
    expect(focused).toContain(`Goal: Explore the tracker\n${focusContext(focus!)}`);
    expect(focused).toContain('Plan every step for the focus on the Focus: line');
    const plain = planInstruction(new ExploreState('Explore the tracker', BUDGETS), { mustFinish: false, remainingMs: 300_000, timeoutMs: 60_000 });
    expect(plain).not.toContain('Focus:');
  });

  it('names each parallel explorer its own virtual file, and a single one the plain file', () => {
    expect(explorerFile(spec(1), 1)).toBe('explore');
    expect([1, 2, 3].map((index) => explorerFile(spec(3), index))).toEqual(['explore/1', 'explore/2', 'explore/3']);
    expect(explorerOfFile('explore/2')).toBe(2);
    expect(explorerOfFile('explore')).toBeUndefined();
    expect(explorerOfFile('explore/0')).toBeUndefined();
    expect(explorerOfFile('tests/explore/2')).toBeUndefined();
  });
});

describe('applyGroups', () => {
  it('keeps the most detailed report of each group, graded as its gravest, with the ids of the others', () => {
    const terse = finding({ severity: 2, kind: 'warning', actual: '0' });
    const detailed = finding({ severity: 3, actual: 'The count next to Issues reads 0 after creating one', explorer: 2 });
    const other = finding({ title: 'Sort ignores direction' });
    const merged = applyGroups([terse, other, detailed], [[2, 0], [1]]);
    expect(merged).toEqual([
      { ...detailed, index: 0, kind: 'issue', severity: 3, merged: [{ id: terse.id, title: terse.title, step: 1 }] },
      { ...other, index: 1, kind: 'issue', severity: 3 },
    ]);
  });

  it('never loses a finding: indices out of range or grouped twice are ignored, and ungrouped ones stand alone', () => {
    const findings = [finding(), finding({ title: 'B' }), finding({ title: 'C' })];
    const merged = applyGroups(findings, [[0, 0, 7, -1], [0, 2]]);
    expect(merged.map((entry) => [entry.id, entry.merged])).toEqual([
      [findings[0]!.id, undefined],
      [findings[1]!.id, undefined],
      [findings[2]!.id, undefined],
    ]);
    expect(merged.map((entry) => entry.index)).toEqual([0, 1, 2]);
  });
});

describe('mergeFindings', () => {
  it('asks the model once with every report and its index, and groups by its answer', async () => {
    const calls: ModelCall<unknown>[] = [];
    const adapter: ModelAdapter = {
      provenance: { provider: 'fake', model: 'merge', endpoint: 'local', adapterVersion: 'test' },
      async generate<Value>(call: ModelCall<Value>) {
        calls.push(call as ModelCall<unknown>);
        const validation = call.validate({ groups: [[0, 1], [2]] });
        if (!validation.ok) throw new Error(validation.issue);
        return { value: validation.value, usage: { inputTokens: 300, outputTokens: 20, accounting: 'provider' as const, estimatedCostUsd: 0.001 }, reasoning: undefined };
      },
    };
    const findings = [finding({ path: '/issues' }), finding({ actual: 'The count reads 0 on the second project' }), finding({ title: 'Sort ignores direction' })];
    const result = await mergeFindings(findings, { adapter, maxInputTokens: 100_000, providerOptions: undefined, signal: new AbortController().signal });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.schemaName).toBe('explore-merge');
    expect(calls[0]!.system).toContain('same kind of screen with different data');
    expect(calls[0]!.prompt).toContain('"index":2');
    expect(calls[0]!.prompt).toContain('"path":"/issues"');
    expect(calls[0]!.prompt).toContain('"reproduction":"Create an issue"');
    expect(calls[0]!.validate({ groups: 'all' }).ok).toBe(false);
    expect(result.findings.map((entry) => entry.merged?.map((absorbed) => absorbed.id))).toEqual([[findings[0]!.id], undefined]);
    expect(result.usage.inputTokens).toBe(300);
  });
});

describe('ExploreRecord', () => {
  it('records a single explorer exactly as its state does, with no explorer tags and no merge', async () => {
    const record = new ExploreRecord(spec(1), neverMerge);
    const state = new ExploreState('Explore the tracker', BUDGETS);
    record.attach(1, state);
    const heard: (number | undefined)[] = [];
    record.subscribe((_, explorer) => heard.push(explorer));
    state.start();
    state.beginStep('Issues', 'Create an issue');
    state.addFinding({ title: 'Count stays at 0', kind: 'issue', severity: 3, expected: 'one', actual: 'zero', reproduction: ['Create an issue'] });
    state.endStep('passed', 'Created');
    state.end('finished', 'Done.');
    await record.settle(scope());
    expect(record.snapshot()).toEqual({ goal: 'Explore the tracker', budgets: BUDGETS, ended: 'finished', summary: 'Done.', steps: state.steps, findings: state.findings });
    expect(heard.every((explorer) => explorer === undefined)).toBe(true);
  });

  it('tags parallel explorers\' steps and findings, lists the explorers, and ends as the least complete of them', () => {
    const record = new ExploreRecord(spec(2), neverMerge);
    const heard: (number | undefined)[] = [];
    record.subscribe((_, explorer) => heard.push(explorer));
    explorerRun(record, 1, [finding()], 'core flows');
    record.relay(2, { phase: 'started', goal: 'Explore the tracker', budgets: BUDGETS, focus: 'edge-case input' });
    record.relay(2, { phase: 'finished', ended: 'time' });
    record.relay(9, { phase: 'finished', ended: 'stuck' });
    const snapshot = record.snapshot();
    expect(snapshot.ended).toBe('time');
    expect(snapshot.summary).toBeUndefined();
    expect(snapshot.steps.map((step) => step.explorer)).toEqual([1]);
    expect(snapshot.findings.map((entry) => [entry.explorer, entry.index])).toEqual([[1, 0]]);
    expect(snapshot.explorers).toEqual([
      { index: 1, focus: 'core flows', ended: 'finished', summary: 'Explorer 1 is done.' },
      { index: 2, focus: 'edge-case input', ended: 'time' },
    ]);
    expect(new Set(heard)).toEqual(new Set([1, 2]));
    assertValidExplore(snapshot);
  });

  it('merges the explorers\' findings once they are over, and announces the merged list', async () => {
    const asked: ReportExploreFinding[][] = [];
    const record = new ExploreRecord(spec(2), async (findings) => {
      asked.push([...findings]);
      return { findings: applyGroups(findings, [[0, 1]]), usage: { inputTokens: 400, outputTokens: 30, accounting: 'provider', estimatedCostUsd: 0.002 } };
    });
    const announced: ExploreProgress[] = [];
    record.subscribe((progress, explorer) => {
      if (explorer === undefined) announced.push(progress);
    });
    const first = finding({ actual: 'The count reads 0 after creating an issue in the first project' });
    const second = finding();
    explorerRun(record, 1, [first]);
    explorerRun(record, 2, [second]);
    await record.settle(scope());
    expect(asked[0]!.map((entry) => [entry.id, entry.explorer, entry.index])).toEqual([[first.id, 1, 0], [second.id, 2, 1]]);
    const snapshot = record.snapshot();
    expect(snapshot.findings).toEqual([{ ...first, explorer: 1, index: 0, merged: [{ id: second.id, title: second.title, explorer: 2, step: 1 }] }]);
    expect(snapshot.merge).toEqual({ status: 'merged', reported: 2, modelTokens: 430, estimatedCostUsd: 0.002 });
    expect(announced).toEqual([{ phase: 'merged', reported: 2, findings: snapshot.findings }]);
    assertValidExplore(snapshot);
  });

  it('keeps every finding with a notice when the merge fails, and skips it when interrupted or with nothing to merge', async () => {
    const failing = new ExploreRecord(spec(2), () => Promise.reject(new Error('provider unavailable')));
    explorerRun(failing, 1, [finding()]);
    explorerRun(failing, 2, [finding()]);
    const notices: string[] = [];
    await failing.settle(scope(notices));
    expect(failing.snapshot().findings).toHaveLength(2);
    expect(failing.snapshot().merge).toEqual({ status: 'failed', reported: 2 });
    expect(notices).toEqual(['the findings of 2 explorers could not be merged, so all 2 are kept: provider unavailable']);

    const interrupted = new ExploreRecord(spec(2), neverMerge);
    explorerRun(interrupted, 1, [finding()]);
    explorerRun(interrupted, 2, [finding()]);
    const controller = new AbortController();
    controller.abort();
    await interrupted.settle(scope([], controller.signal));
    expect(interrupted.snapshot().merge).toBeUndefined();
    expect(interrupted.snapshot().findings).toHaveLength(2);

    const single = new ExploreRecord(spec(2), neverMerge);
    explorerRun(single, 1, [finding()]);
    explorerRun(single, 2, []);
    await single.settle(scope());
    expect(single.snapshot().merge).toBeUndefined();
  });
});
