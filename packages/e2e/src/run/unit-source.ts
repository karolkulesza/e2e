/**
 * Units whose tests are built in memory instead of imported from a file
 * (`e2e explore`). A source builds a virtual file's registration and the
 * policy its attempts run under; the worker core asks it the same way on
 * both transports, and a worker process loads the same source from a module
 * descriptor, since a test body cannot cross a process boundary.
 */

import type { ModuleRegistration } from '../collect/registry.ts';
import type { ResolvedConfig } from '../config/resolve.ts';
import type { E2EConfig } from '../types.ts';

/**
 * How a unit built in memory runs its attempts: as `agents` in place of the
 * config's, when given, and always with the trace cache off, since nothing
 * replays a test that has no source. Setup tests it needs run with the
 * config's own.
 */
export interface UnitAttemptPolicy {
  readonly agents?: ResolvedConfig['agents'] | undefined;
}

/** One virtual file, built: its registration and its attempt policy. */
export interface SourcedUnit {
  readonly registration: ModuleRegistration;
  readonly attempts: UnitAttemptPolicy;
}

/** Receives a unit's own events: plain JSON data, delivered to the run with the unit's file. */
export type UnitEventSink = (event: unknown) => void;

export interface UnitSource {
  /** The virtual files this source builds, in order. */
  readonly files: readonly string[];
  /** Builds `file` afresh; its tests report their unit-scoped events to `emit`. */
  build(file: string, emit: UnitEventSink): SourcedUnit;
}

/** Where a worker process loads a source: a module exporting `createUnitSource`, and the plain data it is built from. */
export interface UnitSourceModule {
  /** A `file:` URL. */
  readonly module: string;
  readonly data: unknown;
}

/** What a source is built from in any process: its data and the config as loaded and resolved there. */
export interface UnitSourceContext {
  readonly data: unknown;
  readonly raw: E2EConfig;
  readonly config: ResolvedConfig;
}

export type CreateUnitSource = (context: UnitSourceContext) => UnitSource;

/** Loads the source a module descriptor names, in this process. */
export async function loadUnitSource(descriptor: UnitSourceModule, context: Omit<UnitSourceContext, 'data'>): Promise<UnitSource> {
  const loaded = (await import(descriptor.module)) as { createUnitSource?: CreateUnitSource };
  if (typeof loaded.createUnitSource !== 'function') {
    throw new Error(`unit source module ${descriptor.module} does not export createUnitSource`);
  }
  return loaded.createUnitSource({ ...context, data: descriptor.data });
}
