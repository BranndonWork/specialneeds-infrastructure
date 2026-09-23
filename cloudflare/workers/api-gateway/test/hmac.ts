// Signs an identity message the way the www server does, so specs can build verified requests.
export async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
	return Array.from(new Uint8Array(mac))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}
