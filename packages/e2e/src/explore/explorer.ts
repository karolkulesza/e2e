/**
 * One explorer of an exploration, built from plain data: the runner's
 * process builds every explorer to collect them as tests, and a worker
 * process builds the one its unit runs, since a test body cannot cross a
 * process boundary. Each explorer is one test in a virtual file of its own,
 * so each is its own work unit.
 */

import type { ModuleRegistration, RegisteredTest } from '../collect/registry.ts';
import { resolveAgentConfig, missingModelError, type ResolvedAgentConfig } from '../config/agent.ts';
import type { ResolvedConfig } from '../config/resolve.ts';
import type { AgentConfig } from '../types.ts';
import { createExploreBody } from './body.ts';
import { explorerAgent, withFindingTool } from './executor.ts';
import { focusContext, type ExploreFocus } from './focus.ts';
import { signedInContext, type PlanAccount } from './plan.ts';
import { explorerOfFile, parallelExplorerFile, type ExploreBudgets, type ExploreProgress } from './progress.ts';
import { ExploreState } from './state.ts';

/** Each step's action and model-call budget when the config sets none: a charter is longer than a scripted step. */
const DEFAULT_STEP_BUDGET = 40;
/** One charter's own deadline; the run's remaining time caps it. */
const STEP_TIMEOUT_MS = 240_000;
/** Added to the test timeout so the body's own clock ends the exploration before the attempt's does. */
const TIMEOUT_GRACE_MS = 60_000;
/** The virtual file the report and the reporters show for a single exploration. */
const EXPLORE_FILE = 'explore';

/** Everything an explorer is built from, as plain data that crosses into a worker process. */
export interface ExploreSpec {
  /** The goal, its static secret values already redacted. */
  readonly goal: string;
  readonly budgets: ExploreBudgets;
  /** The key of the agents entry the explorers run as. */
  readonly agentName: string;
  readonly accounts: readonly PlanAccount[];
  readonly session: string | undefined;
  /** Whether each explorer opens the app first; see `ExploreBodyOptions.openApp`. */
  readonly openApp: boolean;
  /** One focus per explorer, in order; empty when the exploration runs one explorer. */
  readonly focuses: readonly ExploreFocus[];
}

/** What an explorer's agent is built from: the config as loaded and as resolved. */
export interface ExplorerSources {
  /** The agents entry the exploration runs as, as configured; undefined is the built-in agent with no options. */
  readonly entry: AgentConfig | undefined;
  /** The config resolved with the exploration's agent selected. */
  readonly config: ResolvedConfig;
}

/** One explorer, ready to run as a test. */
export interface Explorer {
  /** One-based; 1 when the exploration runs one explorer. */
  readonly index: number;
  readonly file: string;
  readonly state: ExploreState;
  /** The agents its test runs as: the config's, with the explorer in place of the exploration's agent. */
  readonly agents: ResolvedConfig['agents'];
  readonly registration: ModuleRegistration;
  /** The explorer's agent resolved, the finding tool not yet added: the model the findings are merged with. */
  readonly resolved: ResolvedAgentConfig;
}

/** How many explorers the spec runs: one per focus, or one with none. */
export function explorerCount(spec: ExploreSpec): number {
  return Math.max(1, spec.focuses.length);
}

/** The virtual file of explorer `index`: `explore` alone, `explore/<index>` among several. */
export function explorerFile(spec: ExploreSpec, index: number): string {
  return spec.focuses.length === 0 ? EXPLORE_FILE : parallelExplorerFile(index);
}

/**
 * Builds explorer `index`: its record, its agent, and its one-test
 * registration. `notice` hears about a replaced custom executor. No model
 * is `MODEL_UNAVAILABLE`: every exploration step calls the model, a custom
 * executor's included, since the built-in agent replaces it.
 */
export function buildExplorer(spec: ExploreSpec, index: number, sources: ExplorerSources, notice: (message: string) => void): Explorer {
  const focus = spec.focuses[index - 1];
  const state = new ExploreState(spec.goal, spec.budgets, Date.now, focus, explorerCount(spec));
  const { agentName } = spec;
  const explorer = explorerAgent({ state, agentName, entry: sources.entry, resolved: sources.config.agent, notice });
  const resolved = resolveAgentConfig(exploreAgentConfig(explorer), `agents.${agentName}`);
  if (resolved.model === undefined) {
    throw missingModelError(agentName, 'explore runs the built-in agent, which requires a model');
  }
  // The explorer replaces the agent for the exploration alone: a setup test
  // `--session` pulls in runs as the project's own agents, with its cache and
  // retries. The exploration pins no retries and runs with the cache off.
  const agents = new Map(sources.config.agents).set(agentName, withFindingTool(resolved, state));
  return { index, file: explorerFile(spec, index), state, agents, registration: exploreRegistration(spec, state, focus), resolved };
}

/**
 * The explorer's agents entry with per-step budgets that default higher than
 * a scripted step's, a charter being longer.
 */
function exploreAgentConfig(explorer: AgentConfig): AgentConfig {
  return {
    ...explorer,
    maxSteps: explorer.maxSteps ?? DEFAULT_STEP_BUDGET,
    maxModelCalls: explorer.maxModelCalls ?? DEFAULT_STEP_BUDGET,
  };
}

/**
 * The one-test registration: the goal is the title, the body is the
 * exploration loop. With a session it consumes that session like any test
 * declaring `{ session }`, so the runner runs the setup that saves it first
 * and restores it into the exploration's attempt.
 */
function exploreRegistration(spec: ExploreSpec, state: ExploreState, focus: ExploreFocus | undefined): ModuleRegistration {
  const title = state.goal;
  const { session } = spec;
  // The goal reaches every prompt as the test's title (`Test: <goal>`); the
  // session and the focus ride beside it.
  const context = [
    ...(session === undefined ? [] : [signedInContext(session)]),
    ...(focus === undefined ? [] : [focusContext(focus)]),
  ].join('\n\n');
  const test: RegisteredTest = {
    kind: 'test',
    title,
    titlePath: [title],
    declarationIndex: 0,
    options: {
      timeout: state.budgets.timeoutMs + TIMEOUT_GRACE_MS,
      retries: 0,
      ...(context === '' ? {} : { agentContext: context }),
      ...(session === undefined ? {} : { session }),
    },
    sessions: [],
    tags: [],
    fn: createExploreBody({ state, stepTimeoutMs: STEP_TIMEOUT_MS, openApp: spec.openApp, accounts: spec.accounts, session }),
    fixtures: [],
    group: undefined,
    mode: 'normal',
    source: undefined,
  };
  return { tests: [test], hooks: [] };
}

/**
 * The explorers a worker process runs: for the virtual file of one, the
 * explorer built from the spec in this process, its progress relayed to the
 * runner as it happens; undefined for any other file. A replaced executor
 * was already told about by the runner, so it is not told again.
 */
export function workerExplorers(
  spec: ExploreSpec,
  sources: ExplorerSources,
  relay: (explorer: number, progress: ExploreProgress) => void,
): (file: string) => Explorer | undefined {
  return (file) => {
    const index = spec.focuses.length === 0 ? undefined : explorerOfFile(file);
    if (index === undefined || index > spec.focuses.length) return undefined;
    const explorer = buildExplorer(spec, index, sources, () => undefined);
    explorer.state.subscribe((progress) => relay(index, progress));
    return explorer;
  };
}
