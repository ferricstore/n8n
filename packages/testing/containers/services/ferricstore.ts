import type { StartedNetwork } from 'testcontainers';
import { GenericContainer, Wait } from 'testcontainers';

import { createSilentLogConsumer } from '../helpers/utils';
import { TEST_CONTAINER_IMAGES } from '../test-containers';
import type { Service, ServiceResult, StartContext } from './types';

const HOSTNAME = 'ferricstore';
const NATIVE_PORT = 6388;

export interface FerricStoreMeta {
	host: string;
	port: number;
}

export type FerricStoreResult = ServiceResult<FerricStoreMeta>;

function scalingBackend(ctx: StartContext) {
	return ctx.config.env?.N8N_SCALING_BACKEND ?? process.env.N8N_SCALING_BACKEND ?? 'ferricflow';
}

export const ferricstore: Service<FerricStoreResult> = {
	description: 'FerricStore',
	shouldStart: (ctx) => ctx.isQueueMode && scalingBackend(ctx) === 'ferricflow',

	async start(network: StartedNetwork, projectName: string): Promise<FerricStoreResult> {
		const { consumer, throwWithLogs } = createSilentLogConsumer();

		try {
			const container = await new GenericContainer(TEST_CONTAINER_IMAGES.ferricstore)
				.withNetwork(network)
				.withNetworkAliases(HOSTNAME)
				.withExposedPorts(NATIVE_PORT)
				.withEnvironment({
					FERRICSTORE_PROTECTED_MODE: 'false',
				})
				.withWaitStrategy(Wait.forListeningPorts().withStartupTimeout(60_000))
				.withLabels({
					'com.docker.compose.project': projectName,
					'com.docker.compose.service': HOSTNAME,
				})
				.withName(`${projectName}-${HOSTNAME}`)
				.withReuse()
				.withLogConsumer(consumer)
				.start();

			return {
				container,
				meta: {
					host: HOSTNAME,
					port: NATIVE_PORT,
				},
			};
		} catch (error) {
			return throwWithLogs(error);
		}
	},

	env(result: FerricStoreResult, external?: boolean): Record<string, string> {
		const host = external ? result.container.getHost() : HOSTNAME;
		const port = external
			? String(result.container.getMappedPort(NATIVE_PORT))
			: String(NATIVE_PORT);

		return {
			...(external ? { EXECUTIONS_MODE: 'queue' } : {}),
			N8N_SCALING_BACKEND: 'ferricflow',
			N8N_FERRICFLOW_URL: `ferric://${host}:${port}`,
			N8N_CACHE_BACKEND: 'ferricstore',
		};
	},
};
