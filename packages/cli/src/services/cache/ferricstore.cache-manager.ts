/**
 * Cache-manager store backed by FerricStore's Redis-compatible KV commands.
 */

import type { Cache, Config, Store } from 'cache-manager';
import { jsonParse, UnexpectedError } from 'n8n-workflow';

import { responseText, type FerricStoreClient } from '@/scaling/ferricflow/ferricstore-sdk';

class NoCacheableError implements Error {
	name = 'NoCacheableError';

	constructor(public message: string) {}
}

export type FerricStoreCache = Cache<FerricStoreStore>;

export interface FerricStoreStore extends Store {
	readonly isCacheable: (value: unknown) => boolean;
	hget<T>(key: string, field: string): Promise<T | undefined>;
	hgetall<T>(key: string): Promise<Record<string, T> | undefined>;
	hset(key: string, fieldValueRecord: Record<string, unknown>): Promise<void>;
	hkeys(key: string): Promise<string[]>;
	hvals<T>(key: string): Promise<T[]>;
	hexists(key: string, field: string): Promise<boolean>;
	hdel(key: string, field: string): Promise<number>;
	expire(key: string, ttlSeconds: number): Promise<void>;
}

export function ferricStoreUsingClient(
	client: FerricStoreClient,
	options: Config & { keyPrefix?: string } = {},
) {
	const isCacheable = options.isCacheable ?? ((value) => value !== undefined && value !== null);
	const getVal = (value: unknown) => JSON.stringify(value) || '"undefined"';
	const prefixKey = (key: string) => `${options.keyPrefix ?? ''}${key}`;
	const unprefixKey = (key: string) =>
		options.keyPrefix && key.startsWith(options.keyPrefix)
			? key.slice(options.keyPrefix.length)
			: key;
	const decode = <T>(value: unknown): T | undefined => {
		if (value == null) return undefined;
		return jsonParse<T>(responseText(value));
	};

	return {
		async get<T>(key: string) {
			return decode<T>(await client.command('GET', prefixKey(key)));
		},
		async expire(key: string, ttlSeconds: number) {
			await client.command('EXPIRE', prefixKey(key), ttlSeconds);
		},
		async set(key, value, ttl) {
			if (!isCacheable(value)) {
				// eslint-disable-next-line @typescript-eslint/only-throw-error, @typescript-eslint/restrict-template-expressions
				throw new NoCacheableError(`"${value}" is not a cacheable value`);
			}
			const t = ttl ?? options.ttl;
			if (t !== undefined && t !== 0)
				await client.command('SET', prefixKey(key), getVal(value), 'PX', t);
			else await client.command('SET', prefixKey(key), getVal(value));
		},
		async mset(args, ttl) {
			const t = ttl ?? options.ttl;
			await Promise.all(
				args.map(async ([key, value]) => {
					if (!isCacheable(value)) {
						throw new UnexpectedError(`"${getVal(value)}" is not a cacheable value`);
					}
					if (t !== undefined && t !== 0)
						await client.command('SET', prefixKey(key), getVal(value), 'PX', t);
					else await client.command('SET', prefixKey(key), getVal(value));
				}),
			);
		},
		async mget(...args) {
			const values = await client.command('MGET', ...args.map(prefixKey));
			return Array.isArray(values) ? values.map((value) => decode(value)) : [];
		},
		async mdel(...args) {
			if (args.length > 0) await client.command('DEL', ...args.map(prefixKey));
		},
		async del(key) {
			await client.command('DEL', prefixKey(key));
		},
		async ttl(key) {
			return Number(await client.command('PTTL', prefixKey(key)));
		},
		async keys(pattern = '*') {
			const keys = await client.command('KEYS', prefixKey(pattern));
			return Array.isArray(keys) ? keys.map((key) => unprefixKey(responseText(key))) : [];
		},
		async reset() {
			const keys = await client.command('KEYS', prefixKey('*'));
			if (Array.isArray(keys) && keys.length > 0) {
				await client.command('DEL', ...keys);
			}
		},
		isCacheable,
		async hget<T>(key: string, field: string) {
			return decode<T>(await client.command('HGET', prefixKey(key), field));
		},
		async hgetall<T>(key: string) {
			const response = await client.command('HGETALL', prefixKey(key));
			if (!Array.isArray(response) || response.length === 0) return undefined;

			const hash: Record<string, T> = {};
			for (let index = 0; index < response.length; index += 2) {
				const field = responseText(response[index]);
				const value = decode<T>(response[index + 1]);
				if (value !== undefined) hash[field] = value;
			}
			return hash;
		},
		async hset(key: string, fieldValueRecord: Record<string, unknown>) {
			const args: unknown[] = [];
			for (const [field, value] of Object.entries(fieldValueRecord)) {
				if (!isCacheable(value)) {
					// eslint-disable-next-line @typescript-eslint/only-throw-error, @typescript-eslint/restrict-template-expressions
					throw new NoCacheableError(`"${value}" is not a cacheable value`);
				}
				args.push(field, getVal(value));
			}
			if (args.length > 0) await client.command('HSET', prefixKey(key), ...args);
		},
		async hkeys(key: string) {
			const response = await client.command('HKEYS', prefixKey(key));
			return Array.isArray(response) ? response.map(responseText) : [];
		},
		async hvals<T>(key: string) {
			const response = await client.command('HVALS', prefixKey(key));
			return Array.isArray(response)
				? response
						.map((value) => decode<T>(value))
						.filter((value): value is T => value !== undefined)
				: [];
		},
		async hexists(key: string, field: string) {
			return Number(await client.command('HEXISTS', prefixKey(key), field)) === 1;
		},
		async hdel(key: string, field: string) {
			return Number(await client.command('HDEL', prefixKey(key), field));
		},
	} as FerricStoreStore;
}
