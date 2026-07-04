import { instanceRegistrationSchema, type InstanceRegistration } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { Service } from '@n8n/di';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import { jsonParse, jsonStringify } from 'n8n-workflow';

import {
	createFerricStoreClient,
	responseText,
	type FerricStoreClient,
} from '@/scaling/ferricflow/ferricstore-sdk';

import { INSTANCE_REGISTRY_KEY_PATTERNS, REGISTRY_CONSTANTS } from '../instance-registry.types';
import type { InstanceStorage } from './instance-storage.interface';

@Service()
export class FerricStoreInstanceStorage implements InstanceStorage {
	readonly kind = 'ferricstore' as const;

	private readonly logger: Logger;

	private readonly ferricPrefix: string;

	private readonly client: Promise<FerricStoreClient>;

	constructor(logger: Logger, globalConfig: GlobalConfig) {
		this.logger = logger.scoped('instance-registry');
		this.ferricPrefix = globalConfig.queue.ferricflow.prefix;
		this.client = createFerricStoreClient(
			globalConfig.queue.ferricflow.sdkPath,
			globalConfig.queue.ferricflow.url,
			'n8n-ferricflow-instance-registry',
		);
	}

	async register(registration: InstanceRegistration): Promise<void> {
		await this.upsertRegistration(registration);
	}

	async heartbeat(registration: InstanceRegistration): Promise<void> {
		try {
			await this.upsertRegistration(registration);
		} catch (error) {
			this.logger.warn('Failed to heartbeat instance', {
				instanceKey: registration.instanceKey,
				error: ensureError(error).message,
			});
		}
	}

	async unregister(instanceKey: string): Promise<void> {
		try {
			const client = await this.client;
			await client.command('DEL', this.instanceKey(instanceKey));
			await client.command('SREM', this.membershipSetKey(), instanceKey);
		} catch (error) {
			this.logger.warn('Failed to unregister instance', {
				instanceKey,
				error: ensureError(error).message,
			});
		}
	}

	async getAllRegistrations(): Promise<InstanceRegistration[]> {
		try {
			const client = await this.client;
			const rawMembers = await client.command('SMEMBERS', this.membershipSetKey());
			const members = Array.isArray(rawMembers) ? rawMembers.map(responseText) : [];
			if (members.length === 0) return [];

			const rawRegistrations = await client.command(
				'MGET',
				...members.map((member) => this.instanceKey(member)),
			);
			const registrations = Array.isArray(rawRegistrations) ? rawRegistrations : [];

			return registrations
				.map((raw) => this.parseRegistration(raw))
				.filter((registration): registration is InstanceRegistration => registration !== null);
		} catch (error) {
			this.logger.warn('Failed to get all registrations', {
				error: ensureError(error).message,
			});
			return [];
		}
	}

	async getRegistration(instanceKey: string): Promise<InstanceRegistration | null> {
		try {
			return this.parseRegistration(
				await (await this.client).command('GET', this.instanceKey(instanceKey)),
			);
		} catch (error) {
			this.logger.warn('Failed to get registration', {
				instanceKey,
				error: ensureError(error).message,
			});
			return null;
		}
	}

	async getLastKnownState(): Promise<Map<string, InstanceRegistration>> {
		try {
			const raw = await (await this.client).command('GET', this.stateKey());
			if (raw == null) return new Map();

			const record = jsonParse<Record<string, unknown>>(responseText(raw));
			const state = new Map<string, InstanceRegistration>();

			for (const [key, value] of Object.entries(record)) {
				const parsed = instanceRegistrationSchema.safeParse(value);
				if (parsed.success) {
					state.set(key, parsed.data);
				} else {
					this.logger.warn('Skipping invalid state entry', {
						instanceKey: key,
						error: parsed.error.message,
					});
				}
			}

			return state;
		} catch (error) {
			this.logger.warn('Failed to get last known state', {
				error: ensureError(error).message,
			});
			return new Map();
		}
	}

	async saveLastKnownState(state: Map<string, InstanceRegistration>): Promise<void> {
		try {
			const record = Object.fromEntries(state);
			await (await this.client).command(
				'SET',
				this.stateKey(),
				jsonStringify(record),
				'EX',
				REGISTRY_CONSTANTS.STATE_TTL_SECONDS,
			);
		} catch (error) {
			this.logger.warn('Failed to save last known state', {
				error: ensureError(error).message,
			});
		}
	}

	async cleanupStaleMembers(): Promise<number> {
		const client = await this.client;
		try {
			const rawMembers = await client.command('SMEMBERS', this.membershipSetKey());
			const members = Array.isArray(rawMembers) ? rawMembers.map(responseText) : [];
			let removed = 0;

			for (const member of members) {
				const registration = await client.command('GET', this.instanceKey(member));
				if (registration != null) continue;

				await client.command('SREM', this.membershipSetKey(), member);
				removed += 1;
			}

			return removed;
		} catch (error) {
			this.logger.warn('Failed to cleanup stale members', {
				error: ensureError(error).message,
			});
			return 0;
		}
	}

	async destroy(): Promise<void> {
		await (await this.client).close();
	}

	private async upsertRegistration(registration: InstanceRegistration): Promise<void> {
		const client = await this.client;
		await client.command(
			'SET',
			this.instanceKey(registration.instanceKey),
			jsonStringify(registration),
			'EX',
			REGISTRY_CONSTANTS.REGISTRATION_TTL_SECONDS,
		);
		await client.command('SADD', this.membershipSetKey(), registration.instanceKey);
	}

	private parseRegistration(raw: unknown): InstanceRegistration | null {
		if (raw == null) return null;

		try {
			const parsed = instanceRegistrationSchema.safeParse(jsonParse(responseText(raw)));
			if (!parsed.success) {
				this.logger.warn('Skipping invalid registration entry', {
					error: parsed.error.message,
				});
				return null;
			}
			return parsed.data;
		} catch (error) {
			this.logger.warn('Skipping malformed registration entry', {
				error: ensureError(error).message,
			});
			return null;
		}
	}

	private instanceKey(key: string): string {
		return INSTANCE_REGISTRY_KEY_PATTERNS.instanceKey(this.ferricPrefix, key);
	}

	private membershipSetKey(): string {
		return INSTANCE_REGISTRY_KEY_PATTERNS.membershipSet(this.ferricPrefix);
	}

	private stateKey(): string {
		return INSTANCE_REGISTRY_KEY_PATTERNS.stateKey(this.ferricPrefix);
	}
}
