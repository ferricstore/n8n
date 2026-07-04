export const FERRICFLOW_WORKFLOW_STATES = {
	readyToDeliver: 'ready_to_deliver',
	recorded: 'recorded',
} as const;

type ScalingWorkflowChannels = {
	commandChannel: string;
	workerResponseChannel: string;
	mcpRelayChannel: string;
};

export function scalingWorkflowDefinition(
	prefix: string,
	channel: string,
	channels: ScalingWorkflowChannels,
) {
	if (channel === channels.commandChannel) {
		return {
			partitionKey: `${prefix}:n8n:ferricflow:scaling-commands`,
			state: FERRICFLOW_WORKFLOW_STATES.readyToDeliver,
			type: 'n8n_scaling_command',
		};
	}

	if (channel === channels.workerResponseChannel) {
		return {
			partitionKey: `${prefix}:n8n:ferricflow:worker-responses`,
			state: FERRICFLOW_WORKFLOW_STATES.readyToDeliver,
			type: 'n8n_scaling_worker_response',
		};
	}

	if (channel === channels.mcpRelayChannel) {
		return {
			partitionKey: `${prefix}:n8n:ferricflow:mcp-relay`,
			state: FERRICFLOW_WORKFLOW_STATES.readyToDeliver,
			type: 'n8n_scaling_mcp_relay',
		};
	}

	return {
		partitionKey: `${prefix}:n8n:ferricflow:messages:${channel}`,
		state: FERRICFLOW_WORKFLOW_STATES.readyToDeliver,
		type: 'n8n_scaling_message',
	};
}
