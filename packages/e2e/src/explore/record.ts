/**
 * The exploration as the runner's process records it: one copy per
 * explorer, kept from the explorer's progress, whether the explorer runs in
 * this process or in a worker process that relays it. Its snapshot is
 * `run.explore`; with parallel explorers it carries every explorer's steps
 * and the findings once merged.
 */

import { errorMessage } from '../internal/errors.ts';
import type { ReportExplore, ReportExploreFinding, ReportExploreMerge, ReportExploreStep } from '../report/build.ts';
import { explorerCount, type ExploreSpec } from './explorer.ts';
import type { MergeResult } from './merge.ts';
import type { ExploreProgress } from './progress.ts';
import type { ExploreState } from './state.ts';

/** Hears every moment of every explorer; `explorer` is one-based, and undefined with a single explorer or for the merge. */
export type ExploreRecordListener = (progress: ExploreProgress, explorer: number | undefined) => void;

/** Merges the findings of parallel explorers; see `mergeFindings`. */
export type MergeFindings = (findings: readonly ReportExploreFinding[], signal: AbortSignal) => Promise<MergeResult>;

/** One explorer's record, as its progress built it. */
interface Copy {
  ended: ReportExplore['ended'];
  summary: string | undefined;
  readonly steps: ReportExploreStep[];
  readonly findings: ReportExploreFinding[];
}

/** Endings from the least complete: the exploration as a whole ended as the first of these any explorer did. */
const ENDINGS: readonly ReportExplore['ended'][] = ['aborted', 'stuck', 'time', 'step-limit', 'finished'];

export class ExploreRecord {
  readonly #copies: Copy[];
  readonly #listeners: ExploreRecordListener[] = [];
  #merged: { readonly findings: readonly ReportExploreFinding[]; readonly merge: ReportExploreMerge } | undefined;

  constructor(
    private readonly spec: ExploreSpec,
    private readonly merge: MergeFindings,
  ) {
    this.#copies = Array.from({ length: explorerCount(spec) }, () => ({ ended: 'aborted', summary: undefined, steps: [], findings: [] }));
  }

  /** Whether several explorers run. */
  get parallel(): boolean {
    return this.#copies.length > 1;
  }

  /** Records an explorer that runs in this process, from its own state. */
  attach(explorer: number, state: ExploreState): void {
    state.subscribe((progress) => this.relay(explorer, progress));
  }

  /** Registers a listener for every moment from here on. */
  subscribe(listener: ExploreRecordListener): void {
    this.#listeners.push(listener);
  }

  /** Records one moment of explorer `explorer` (one-based) and passes it on; an unknown explorer is ignored. */
  relay(explorer: number, progress: ExploreProgress): void {
    const copy = this.#copies[explorer - 1];
    if (copy === undefined) return;
    switch (progress.phase) {
      case 'step-finished':
        copy.steps.push(progress.step);
        break;
      case 'finding':
        copy.findings.push(progress.finding);
        break;
      case 'finished':
        copy.ended = progress.ended;
        copy.summary = progress.summary;
        break;
      default:
        break;
    }
    this.#notify(progress, this.parallel ? explorer : undefined);
  }

  #notify(progress: ExploreProgress, explorer: number | undefined): void {
    for (const listener of this.#listeners) listener(progress, explorer);
  }

  /**
   * Once every explorer is over: merges the findings of parallel explorers
   * that describe the same failure. A failed merge keeps every finding, with
   * a notice; an interrupted run is not merged. Runs once.
   */
  async settle(scope: { readonly signal: AbortSignal; readonly notice: (message: string) => void }): Promise<void> {
    if (!this.parallel || this.#merged !== undefined || scope.signal.aborted) return;
    const reported = this.#findings();
    if (reported.length < 2) return;
    try {
      const { findings, usage } = await this.merge(reported, scope.signal);
      this.#merged = {
        findings,
        merge: {
          status: 'merged',
          reported: reported.length,
          modelTokens: usage.inputTokens + usage.outputTokens,
          ...(usage.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: usage.estimatedCostUsd }),
        },
      };
      this.#notify({ phase: 'merged', reported: reported.length, findings }, undefined);
    } catch (cause) {
      if (scope.signal.aborted) return;
      this.#merged = { findings: reported, merge: { status: 'failed', reported: reported.length } };
      scope.notice(`the findings of ${String(this.#copies.length)} explorers could not be merged, so all ${String(reported.length)} are kept: ${errorMessage(cause)}`);
    }
  }

  /** Every explorer's findings in explorer order, each tagged with its explorer and numbered across all of them. */
  #findings(): ReportExploreFinding[] {
    return this.#copies
      .flatMap((copy, position) => copy.findings.map((finding) => ({ ...finding, explorer: position + 1 })))
      .map((finding, index) => ({ ...finding, index }));
  }

  snapshot(): ReportExplore {
    const { goal, budgets } = this.spec;
    const base = { goal, budgets: { maxSteps: budgets.maxSteps, timeoutMs: budgets.timeoutMs } };
    if (!this.parallel) {
      const copy = this.#copies[0]!;
      return {
        ...base,
        ended: copy.ended,
        ...(copy.summary === undefined ? {} : { summary: copy.summary }),
        steps: [...copy.steps],
        findings: [...copy.findings],
      };
    }
    const endings = new Set(this.#copies.map((copy) => copy.ended));
    return {
      ...base,
      ended: ENDINGS.find((ended) => endings.has(ended)) ?? 'aborted',
      steps: this.#copies.flatMap((copy, position) => copy.steps.map((step) => ({ ...step, explorer: position + 1 }))),
      findings: [...(this.#merged?.findings ?? this.#findings())],
      explorers: this.#copies.map((copy, position) => ({
        index: position + 1,
        focus: this.spec.focuses[position]!.label,
        ended: copy.ended,
        ...(copy.summary === undefined ? {} : { summary: copy.summary }),
      })),
      ...(this.#merged === undefined ? {} : { merge: this.#merged.merge }),
    };
  }
}
