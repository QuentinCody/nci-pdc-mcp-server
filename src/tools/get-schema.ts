import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createGetSchemaHandler } from "@bio-mcp/shared/staging/utils";

interface SchemaEnv { PDC_DATA_DO?: unknown; }

export function registerGetSchema(server: McpServer, env?: SchemaEnv) {
	const handler = createGetSchemaHandler("PDC_DATA_DO", "pdc");
	server.registerTool("pdc_get_schema", {
		title: "Get Staged Data Schema",
		description: "Inspect the schema of previously staged NCI PDC data.",
		inputSchema: {
			data_access_id: z.string().min(1).describe("Data access ID from a staged response"),
		},
	}, async (args, extra) => {
		const runtimeEnv = env || (extra as { env?: SchemaEnv })?.env || {};
		return handler(args as Record<string, unknown>, runtimeEnv as Record<string, unknown>);
	});
}
