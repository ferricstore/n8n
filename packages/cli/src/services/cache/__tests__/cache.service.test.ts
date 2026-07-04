import { GlobalConfig } from '@n8n/config';
import { Container } from '@n8n/di';
import random from 'lodash/random';
import { sleep } from 'n8n-workflow';

import config from '@/config';
import { CacheService } from '@/services/cache/cache.service';

const ferricStoreMock = vi.hoisted(() => {
	type Entry =
		| { kind: 'string'; value: string; expiresAt?: number }
		| { kind: 'hash'; value: Map<string, string>; expiresAt?: number };
	const data = new Map<string, Entry>();
	const isExpired = (entry: Entry) =>
		entry.expiresAt !== undefined && Date.now() >= entry.expiresAt;
	const getEntry = (key: string) => {
		const entry = data.get(key);
		if (!entry) return undefined;
		if (isExpired(entry)) {
			data.delete(key);
			return undefined;
		}
		return entry;
	};
	const patternToRegex = (pattern: string) =>
		new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);
	const text = (value: unknown) =>
		Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
	const client = {
		async close() {},
		async command(command: string, ...args: unknown[]) {
			switch (command) {
				case 'GET': {
					const entry = getEntry(text(args[0]));
					return entry?.kind === 'string' ? entry.value : null;
				}
				case 'SET': {
					const key = text(args[0]);
					const value = text(args[1]);
					const pxIndex = args.findIndex((arg) => text(arg).toUpperCase() === 'PX');
					const expiresAt =
						pxIndex >= 0 && args[pxIndex + 1] !== undefined
							? Date.now() + Number(args[pxIndex + 1])
							: undefined;
					data.set(key, { kind: 'string', value, expiresAt });
					return 'OK';
				}
				case 'MGET':
					return args.map((key) => {
						const entry = getEntry(text(key));
						return entry?.kind === 'string' ? entry.value : null;
					});
				case 'DEL': {
					let deleted = 0;
					for (const key of args) {
						if (data.delete(text(key))) deleted += 1;
					}
					return deleted;
				}
				case 'PTTL': {
					const entry = getEntry(text(args[0]));
					if (!entry) return -2;
					if (entry.expiresAt === undefined) return -1;
					return Math.max(0, entry.expiresAt - Date.now());
				}
				case 'EXPIRE': {
					const entry = getEntry(text(args[0]));
					if (!entry) return 0;
					entry.expiresAt = Date.now() + Number(args[1]) * 1000;
					return 1;
				}
				case 'KEYS': {
					const regex = patternToRegex(text(args[0]));
					return [...data.keys()].filter((key) => getEntry(key) !== undefined && regex.test(key));
				}
				case 'HSET': {
					const key = text(args[0]);
					const current = getEntry(key);
					const hash =
						current?.kind === 'hash'
							? current
							: ({ kind: 'hash', value: new Map<string, string>() } satisfies Entry);
					for (let index = 1; index < args.length; index += 2) {
						hash.value.set(text(args[index]), text(args[index + 1]));
					}
					data.set(key, hash);
					return args.length > 1 ? Math.floor((args.length - 1) / 2) : 0;
				}
				case 'HGET': {
					const entry = getEntry(text(args[0]));
					return entry?.kind === 'hash' ? (entry.value.get(text(args[1])) ?? null) : null;
				}
				case 'HGETALL': {
					const entry = getEntry(text(args[0]));
					return entry?.kind === 'hash' ? [...entry.value.entries()].flat() : [];
				}
				case 'HKEYS': {
					const entry = getEntry(text(args[0]));
					return entry?.kind === 'hash' ? [...entry.value.keys()] : [];
				}
				case 'HVALS': {
					const entry = getEntry(text(args[0]));
					return entry?.kind === 'hash' ? [...entry.value.values()] : [];
				}
				case 'HEXISTS': {
					const entry = getEntry(text(args[0]));
					return entry?.kind === 'hash' && entry.value.has(text(args[1])) ? 1 : 0;
				}
				case 'HDEL': {
					const entry = getEntry(text(args[0]));
					return entry?.kind === 'hash' && entry.value.delete(text(args[1])) ? 1 : 0;
				}
				default:
					throw new Error(`Unexpected FerricStore command: ${command}`);
			}
		},
	};

	return {
		client,
		createFerricStoreClient: vi.fn(async () => client),
		reset: () => data.clear(),
		responseText: text,
	};
});

vi.mock('@/scaling/ferricflow/ferricstore-sdk', () => ferricStoreMock);

vi.mock('ioredis', () => {
	const Redis = require('ioredis-mock');

	return {
		// Must be a function expression (not method shorthand) so it is
		// constructable via `new Redis(...)` in the service under test.
		// eslint-disable-next-line object-shorthand
		default: function (...args: unknown[]) {
			return new Redis(args);
		},
	};
});

const ensureFerricStoreCacheConfig = (globalConfig: GlobalConfig) => {
	globalConfig.cache.ferricstore ??= {
		prefix: 'cache',
		ttl: 3_600_000,
	};
};

for (const backend of ['memory', 'redis', 'ferricstore'] as const) {
	describe(backend, () => {
		let cacheService: CacheService;
		let globalConfig: GlobalConfig;

		beforeAll(async () => {
			globalConfig = Container.get(GlobalConfig);
			ensureFerricStoreCacheConfig(globalConfig);
			globalConfig.cache.backend = backend;
			globalConfig.queue.backend = 'bull';
			cacheService = new CacheService(globalConfig);
			await cacheService.init();
		});

		afterEach(async () => {
			await cacheService.reset();
			ferricStoreMock.reset();
			config.load(config.default);
			ensureFerricStoreCacheConfig(globalConfig);
		});

		describe('init', () => {
			test('should select backend based on config', () => {
				expect(cacheService.isMemory()).toBe(backend === 'memory');
				expect(cacheService.isRedis()).toBe(backend === 'redis');
				expect(cacheService.isFerricStore()).toBe(backend === 'ferricstore');
			});

			if (backend === 'redis') {
				describe('when backend is redis', () => {
					test('with auto backend and queue mode, should select redis', async () => {
						globalConfig.executions.mode = 'queue';

						await cacheService.init();

						expect(cacheService.isRedis()).toBe(true);
					});
				});
			}

			if (backend === 'ferricstore') {
				describe('when backend is ferricstore', () => {
					test('with auto backend and queue mode using FerricFlow, should select ferricstore', async () => {
						globalConfig.cache.backend = 'auto';
						globalConfig.executions.mode = 'queue';
						globalConfig.queue.backend = 'ferricflow';

						await cacheService.init();

						expect(cacheService.isFerricStore()).toBe(true);
					});
				});
			}

			if (backend === 'memory') {
				test('should honor max size when enough', async () => {
					globalConfig.cache.memory.maxSize = 16; // enough bytes for "withoutUnicode"

					await cacheService.init();
					await cacheService.set('key', 'withoutUnicode');

					await expect(cacheService.get('key')).resolves.toBe('withoutUnicode');

					// restore
					globalConfig.cache.memory.maxSize = 3 * 1024 * 1024;
					await cacheService.init();
				});

				test('should honor max size when not enough', async () => {
					globalConfig.cache.memory.maxSize = 16; // not enough bytes for "withUnicodeԱԲԳ"

					await cacheService.init();
					await cacheService.set('key', 'withUnicodeԱԲԳ');

					await expect(cacheService.get('key')).resolves.toBeUndefined();

					// restore
					globalConfig.cache.memory.maxSize = 3 * 1024 * 1024;
					// restore
					await cacheService.init();
				});
			}
		});

		describe('set', () => {
			test('should set a string value', async () => {
				await cacheService.set('key', 'value');

				await expect(cacheService.get('key')).resolves.toBe('value');
			});

			test('should set a number value', async () => {
				await cacheService.set('key', 123);

				await expect(cacheService.get('key')).resolves.toBe(123);
			});

			test('should set an object value', async () => {
				const object = { a: { b: { c: { d: 1 } } } };

				await cacheService.set('key', object);

				await expect(cacheService.get('key')).resolves.toMatchObject(object);
			});

			test('should not cache `null` or `undefined` values', async () => {
				await cacheService.set('key1', null);
				await cacheService.set('key2', undefined);
				await cacheService.set('key3', 'value');
				await cacheService.set('key4', false);
				await cacheService.set('key5', 0);
				await cacheService.set('key6', '');

				await expect(cacheService.get('key1')).resolves.toBeUndefined();
				await expect(cacheService.get('key2')).resolves.toBeUndefined();
				await expect(cacheService.get('key3')).resolves.toBe('value');
				await expect(cacheService.get('key4')).resolves.toBe(false);
				await expect(cacheService.get('key5')).resolves.toBe(0);
				await expect(cacheService.get('key6')).resolves.toBe('');
			});

			test('should disregard zero-length keys', async () => {
				await cacheService.set('', 'value');

				await expect(cacheService.get('')).resolves.toBeUndefined();
			});

			test('should honor ttl', async () => {
				await cacheService.set('key', 'value', 100);

				await expect(cacheService.get('key')).resolves.toBe('value');

				await sleep(200);

				await expect(cacheService.get('key')).resolves.toBeUndefined();
			});
		});

		describe('get', () => {
			const createRefreshFn = () => vi.fn(async () => await Promise.resolve('refreshValue'));

			test('should fall back to fallback value', async () => {
				const promise = cacheService.get('key', { fallbackValue: 'fallback' });
				await expect(promise).resolves.toBe('fallback');
			});

			test('should refresh value', async () => {
				const refreshFn = createRefreshFn();
				const promise = cacheService.get('testString', { refreshFn });

				await expect(promise).resolves.toBe('refreshValue');
			});

			test('should handle non-ASCII key', async () => {
				const nonAsciiKey = 'ԱԲԳ';
				await cacheService.set(nonAsciiKey, 'value');

				await expect(cacheService.get(nonAsciiKey)).resolves.toBe('value');
			});

			test('should treat empty array placeholder as cache hit when key is present', async () => {
				const refreshFn = createRefreshFn();

				await cacheService.set('testString', []);
				const value = await cacheService.get('testString', { refreshFn });
				expect(value).toEqual([]);
				expect(refreshFn).not.toHaveBeenCalled();
			});

			if (backend !== 'memory') {
				describe('when backend is external', () => {
					test('should treat empty array placeholder as cache miss when key is missing', async () => {
						const refreshFn = createRefreshFn();

						const value = await cacheService.get('testString', { refreshFn });
						expect(value).toBe('refreshValue');
						expect(refreshFn).toHaveBeenCalledTimes(1);
					});

					test.each([
						['an empty array', []],
						['an array with items', ['item1', 'item2']],
						['a string', 'value'],
						['an empty string', ''],
						['a number', random(1, 1000)],
						['a zero', 0],
						['"true"', true],
						['"false"', false],
						['an object', { foo: 'bar' }],
						['an empty object', {}],
					])('should treat a key as cache hit when value is %s', async (_type, valueToSet) => {
						const refreshFn = createRefreshFn();

						await cacheService.set('testString', valueToSet);
						const value = await cacheService.get('testString', { refreshFn });
						expect(value).toEqual(valueToSet);
						expect(refreshFn).not.toHaveBeenCalled();
					});
				});
			}
		});

		describe('delete', () => {
			test('should delete a key', async () => {
				await cacheService.set('key', 'value');

				await cacheService.delete('key');

				await expect(cacheService.get('key')).resolves.toBeUndefined();
			});
		});

		describe('setMany', () => {
			test('should set multiple string values', async () => {
				await cacheService.setMany([
					['key1', 'value1'],
					['key2', 'value2'],
				]);

				await expect(cacheService.get('key1')).resolves.toBe('value1');
				await expect(cacheService.get('key2')).resolves.toBe('value2');
			});

			test('should set multiple number values', async () => {
				await cacheService.setMany([
					['key1', 123],
					['key2', 456],
				]);

				await expect(cacheService.get('key1')).resolves.toBe(123);
				await expect(cacheService.get('key2')).resolves.toBe(456);
			});

			test('should disregard zero-length keys', async () => {
				await cacheService.setMany([['', 'value1']]);

				await expect(cacheService.get('')).resolves.toBeUndefined();
			});
		});

		describe('getHash', () => {
			const createHashRefreshFn = () =>
				vi.fn(async (_key: string) => await Promise.resolve({ field: 'refreshValue' }));

			test('should treat hash as cache hit when key is present', async () => {
				const refreshFn = createHashRefreshFn();
				await cacheService.setHash('testHash', { field: 'value' });

				const value = await cacheService.getHash('testHash', { refreshFn });
				expect(value).toEqual({ field: 'value' });
				expect(refreshFn).not.toHaveBeenCalled();
			});

			if (backend !== 'memory') {
				describe('when backend is external', () => {
					test('should treat empty hash placeholder as cache miss when key is missing', async () => {
						const refreshFn = createHashRefreshFn();
						await expect(cacheService.getHash('testHash', { refreshFn })).resolves.toEqual({
							field: 'refreshValue',
						});
						expect(refreshFn).toHaveBeenCalledTimes(1);
					});
				});
			}
		});

		describe('delete', () => {
			test('should handle non-ASCII key', async () => {
				const nonAsciiKey = 'ԱԲԳ';
				await cacheService.set(nonAsciiKey, 'value');
				await expect(cacheService.get(nonAsciiKey)).resolves.toBe('value');

				await cacheService.delete(nonAsciiKey);

				await expect(cacheService.get(nonAsciiKey)).resolves.toBeUndefined();
			});
		});

		describe('setHash', () => {
			test('should set a hash if non-existing', async () => {
				await cacheService.setHash('keyW', { field: 'value' });

				await expect(cacheService.getHash('keyW')).resolves.toStrictEqual({ field: 'value' });
			});

			test('should add to a hash value if existing', async () => {
				await cacheService.setHash('key', { field1: 'value1' });
				await cacheService.setHash('key', { field2: 'value2' });

				await expect(cacheService.getHash('key')).resolves.toStrictEqual({
					field1: 'value1',
					field2: 'value2',
				});
			});
		});

		describe('deleteFromHash', () => {
			test('should delete a hash field', async () => {
				await cacheService.setHash('key', { field1: 'value1', field2: 'value2' });
				await cacheService.deleteFromHash('key', 'field1');

				await expect(cacheService.getHash('key')).resolves.toStrictEqual({ field2: 'value2' });
			});
		});

		describe('getHashValue', () => {
			test('should return a hash field value', async () => {
				await cacheService.setHash('key', { field1: 'value1', field2: 'value2' });

				await expect(cacheService.getHashValue('key', 'field1')).resolves.toBe('value1');
			});
		});
	});
}
