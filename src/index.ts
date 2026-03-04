import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shouldStage, stageToDoAndRespond } from "@bio-mcp/shared/staging/utils";
import { PdcDataDO } from "./do";
import { registerQueryData } from "./tools/query-data";
import { registerGetSchema } from "./tools/get-schema";

// Export Durable Object classes
export { PdcDataDO };

// Define our NCI PDC MCP agent
export class NciPdcMCP extends McpAgent {
	server = new McpServer({
		name: "NciPdcExplorer",
		version: "0.1.0",
		description: "MCP Server for querying the NCI Proteomic Data Commons (PDC) GraphQL API. PDC provides access to publicly available cancer-related proteomic datasets and associated metadata."
	});

	// NCI PDC API Configuration
	private readonly PDC_GRAPHQL_ENDPOINT = 'https://pdc.cancer.gov/graphql';

	async init() {
		console.error("NCI PDC MCP Server initialized.");
		const env = this.env as unknown as PdcEnv;

		// Register staging tools
		registerQueryData(this.server, env);
		registerGetSchema(this.server, env);

		// Register the GraphQL execution tool
		this.server.tool(
			"pdc_graphql_query",
			"Executes a GraphQL query against the NCI Proteomic Data Commons (PDC) API (https://pdc.cancer.gov/graphql). " +
			"PDC provides access to publicly available cancer-related proteomic datasets and associated metadata (biospecimen, clinical, etc.). " +
			"Many queries require `acceptDUA: true` as an argument within the query string itself (e.g., `case(..., acceptDUA: true)` or `fileMetadata(..., acceptDUA: true)`). " +
			"PDC studies can have multiple versions. By default, queries by PDC study ID (e.g., PDC000121) return data for the latest version. Queries by UUID-based study ID target specific versions. " +
			"For example, to find information about a case: " +
			"'{ case(case_submitter_id: \"01BR001\" acceptDUA: true) { case_submitter_id project_submitter_id disease_type } }'. " +
			"To find metadata for a file: " +
			"'{ fileMetadata(file_id: \"00046804-1b57-11e9-9ac1-005056921935\" acceptDUA: true) { file_name file_size md5sum data_category } }'. " +
			"Use GraphQL introspection for schema discovery: '{ __schema { queryType { name } types { name kind description fields { name args { name type { name ofType { name } } } } } } }'. " +
			"Refer to the PDC GraphQL API documentation (schema available via introspection or PDC website) for more examples and details. If a query fails, check the syntax, required arguments like `acceptDUA`, and retry.",
			{
				query: z.string().describe(
					"The GraphQL query string to execute against the NCI PDC GraphQL API. " +
					"Example: '{ case(case_submitter_id: \"01BR001\" acceptDUA: true) { project_submitter_id disease_type } }'. " +
					"Use introspection queries like '{ __schema { queryType { name } types { name kind } } }' to discover the schema. "
				),
				variables: z.record(z.any()).optional().describe(
					"Optional dictionary of variables for the GraphQL query. Example: { \"caseId\": \"01BR001\" }"
				),
			},
			async ({ query, variables }: { query: string; variables?: Record<string, any> }) => {
				console.error(`Executing pdc_graphql_query with query: ${query.slice(0, 200)}...`);
				if (variables) {
					console.error(`With variables: ${JSON.stringify(variables).slice(0,150)}...`);
				}

				const result = await this.executePdcGraphQLQuery(query, variables);

				// Auto-stage large responses
				const responseString = JSON.stringify(result);
				if (shouldStage(responseString.length) && env?.PDC_DATA_DO) {
					try {
						const staged = await stageToDoAndRespond(
							result,
							env.PDC_DATA_DO as any,
							"pdc",
							undefined,
							undefined,
							"pdc",
						);
						const summary = `PDC GraphQL response staged (${staged.totalRows ?? 0} rows across ${staged.tablesCreated?.length ?? 0} tables). Use pdc_query_data with data_access_id '${staged.dataAccessId}'.`;
						return {
							content: [{ type: "text" as const, text: summary }],
							structuredContent: {
								success: true,
								staged: true,
								data_access_id: staged.dataAccessId,
								tables_created: staged.tablesCreated,
								total_rows: staged.totalRows,
								schema: staged.schema,
								_staging: staged._staging,
							},
						};
					} catch (stageErr) {
						console.error("Auto-staging failed, returning inline:", stageErr);
						// Fall through to inline response
					}
				}

				return {
					content: [{
						type: "text" as const,
						text: responseString
					}]
				};
			}
		);
	}

	// Helper function to execute NCI PDC GraphQL queries
	private async executePdcGraphQLQuery(query: string, variables?: Record<string, any>): Promise<any> {
		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				"User-Agent": "MCPNciPdcServer/0.1.0 (ModelContextProtocol; +https://modelcontextprotocol.io)"
			};
			
			const bodyData: Record<string, any> = { query };
			if (variables) {
				bodyData.variables = variables;
			}
			
			console.error(`Making GraphQL request to: ${this.PDC_GRAPHQL_ENDPOINT}`);
			// console.error(`Request body: ${JSON.stringify(bodyData)}`); // Potentially too verbose

			const response = await fetch(this.PDC_GRAPHQL_ENDPOINT, {
				method: 'POST',
				headers,
				body: JSON.stringify(bodyData),
			});
			
			console.error(`NCI PDC API response status: ${response.status}`);
			
			let responseBody;
			const contentType = response.headers.get("content-type");
			if (contentType && contentType.includes("application/json")) {
				try {
					responseBody = await response.json();
				} catch (e) {
					// If JSON parsing fails despite header, try to get text for error reporting
					const errorText = await response.text();
					console.error(`NCI PDC API response indicates JSON but failed to parse. Status: ${response.status}, Body: ${errorText.slice(0,500)}`);
					return {
						errors: [{
							message: `NCI PDC API Error ${response.status}: Failed to parse JSON response.`,
							extensions: {
								statusCode: response.status,
								responseText: errorText.slice(0, 1000) // Truncate long non-JSON responses
							}
						}]
					};
				}
			} else {
				// Handle non-JSON responses (e.g. HTML error pages, plain text)
				const errorText = await response.text();
				console.error(`NCI PDC API response is not JSON. Status: ${response.status}, Content-Type: ${contentType}, Body: ${errorText.slice(0,500)}`);
				return {
					errors: [{
						message: `NCI PDC API Error ${response.status}: Non-JSON response received.`,
						extensions: {
							statusCode: response.status,
							contentType: contentType,
							responseText: errorText.slice(0, 1000)
						}
					}]
				};
			}


			if (!response.ok) {
				console.error(`NCI PDC API HTTP Error ${response.status}: ${JSON.stringify(responseBody)}`);
				// Structure this similar to a GraphQL error response if possible,
				// or ensure the body (which might contain PDC's own error structure) is passed.
				return {
					errors: [{ 
						message: `NCI PDC API HTTP Error ${response.status}`,
						extensions: {
							statusCode: response.status,
							responseBody: responseBody // This could be PDC's error object or the parsed JSON
						}
					}]
				};
			}
			
			// If response.ok, responseBody contains the GraphQL result (which might include a `data` and/or `errors` field)
			return responseBody;

		} catch (error) {
			// This catch block handles network errors or other issues with the fetch call itself
			console.error(`Client-side error during NCI PDC GraphQL request: ${error instanceof Error ? error.message : String(error)}`);
			let errorMessage = "An unexpected client-side error occurred while attempting to query the NCI PDC GraphQL API.";
			if (error instanceof Error) {
					errorMessage = error.message;
			} else {
					errorMessage = String(error);
			}
			return { 
				errors: [{ 
					message: errorMessage,
                    extensions: {
                        clientError: true // Custom extension to indicate client-side nature of the error
                    }
				}]
			};
		}
	}
}

interface PdcEnv {
	MCP_HOST?: string;
	MCP_PORT?: string;
	PDC_DATA_DO: DurableObjectNamespace;
}

// Dummy ExecutionContext for type compatibility, usually provided by the runtime environment.
interface ExecutionContext {
	waitUntil(promise: Promise<any>): void;
	passThroughOnException(): void;
}

// Export the fetch handler, standard for environments like Cloudflare Workers or Deno Deploy.
export default {
	async fetch(request: Request, env: PdcEnv, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Streamable HTTP transport (MCP 2025-11-25 spec)
		if (url.pathname.startsWith("/mcp")) {
			return NciPdcMCP.serve("/mcp", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
		}

		// SSE transport (legacy, kept for backward compatibility)
		if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
			// @ts-ignore
			return NciPdcMCP.serveSSE("/sse", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
		}

		// Fallback for unhandled paths
		return new Response(
			`NCI PDC MCP Server - Path not found.\nAvailable MCP paths:\n- /mcp (Streamable HTTP)\n- /sse (Server-Sent Events)`,
			{
				status: 404,
				headers: { "Content-Type": "text/plain" }
			}
		);
	},
};

// Export the main class, e.g., for Cloudflare Workers Durable Objects or other module systems.
export { NciPdcMCP as MyMCP };