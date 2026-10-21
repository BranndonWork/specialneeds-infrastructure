import type { Env as WorkerEnv } from '../src/index';

declare module 'cloudflare:test' {
	// The generated Env leaves out secrets; the worker's own Env declares them.
	interface ProvidedEnv extends WorkerEnv {}
}
