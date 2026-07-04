import type { MemoryCache } from 'cache-manager';

import type { RedisCache } from '@/services/cache/redis.cache-manager';
import type { FerricStoreCache } from '@/services/cache/ferricstore.cache-manager';

export type TaggedRedisCache = RedisCache & { kind: 'redis' };

export type TaggedFerricStoreCache = FerricStoreCache & { kind: 'ferricstore' };

export type TaggedMemoryCache = MemoryCache & { kind: 'memory' };

export type Hash<T = unknown> = Record<string, T>;

export type MaybeHash<T> = Hash<T> | undefined;
