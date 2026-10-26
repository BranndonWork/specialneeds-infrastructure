// Reads the failover decision the api-gateway's probe writes to the shared FAILOVER_KV
// namespace. This Worker never writes it; it only follows the gateway onto the standby.

const FAILOVER_STATE_KEY = 'failover:state';
const STATE_CACHE_MS = 30_000;

let cached: { active: boolean; at: number } | null = null;

async function readActive(kv: KVNamespace | undefined): Promise<boolean> {
	if (!kv) return false;
	try {
		const raw = await kv.get(FAILOVER_STATE_KEY);
		return raw ? JSON.parse(raw).active === true : false;
	} catch (err) {
		console.log(`[failover] state read error, assuming primary: ${err}`);
		return false;
	}
}

export async function isFailoverActive(kv: KVNamespace | undefined): Promise<boolean> {
	if (cached && Date.now() - cached.at < STATE_CACHE_MS) return cached.active;
	const active = await readActive(kv);
	cached = { active, at: Date.now() };
	return active;
}

export function invalidateFailoverCache(): void {
	cached = null;
}
