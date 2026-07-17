/**
 * @pebble/mcp — exposes Module 02 (Estimate Crafting Space) over the Model
 * Context Protocol, keeping the module swappable as more Pebble modules ship.
 *
 * Dependency-light by design: the server takes injected service callbacks
 * (implemented by the web app / worker with real db access) so this package
 * only depends on the MCP SDK + shared contracts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  enquiryInputSchema,
  type EnquiryInput,
  SYSTEM_TYPES,
} from "@pebble/shared";

/** Services the host application injects — mirrors packages/ai ToolServices. */
export interface PebbleMcpServices {
  createEnquiryAndGenerate(
    input: EnquiryInput,
    actor: string,
  ): Promise<{ enquiryId: string; estimateId: string }>;
  getEstimate(estimateId: string, versionNo?: number): Promise<unknown>;
  listEstimates(): Promise<unknown[]>;
  getMasterSummary(): Promise<{
    materials: number;
    makes: number;
    rules: number;
  }>;
  searchPastEstimates(
    query: string,
  ): Promise<Array<{ filename: string; snippet: string; score: number }>>;
}

export interface CreatePebbleMcpServerOptions {
  services: PebbleMcpServices;
  /** Actor recorded in the audit trail for MCP-initiated actions. */
  actor?: string;
}

/**
 * Build the Module 02 MCP server. Transport (stdio / streamable HTTP) is the
 * caller's choice — call `server.connect(transport)` after creation.
 */
export function createPebbleMcpServer(
  opts: CreatePebbleMcpServerOptions,
): McpServer {
  const { services } = opts;
  const actor = opts.actor ?? "mcp-client";

  const server = new McpServer({
    name: "pebble-module-02-estimate-crafting",
    version: "0.1.0",
  });

  server.tool(
    "create_enquiry_and_generate",
    "Create a fire-safety enquiry (spec A.08) and deterministically generate draft estimate v1. " +
      "All pricing is computed by the deterministic engine — never by a model.",
    enquiryInputSchema.shape,
    async (args) => {
      const input = enquiryInputSchema.parse(args);
      const result = await services.createEnquiryAndGenerate(input, actor);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.tool(
    "get_estimate",
    "Fetch an estimate with version metadata and line items.",
    {
      estimateId: z.string().min(1),
      versionNo: z.number().int().positive().optional(),
    },
    async ({ estimateId, versionNo }) => {
      const result = await services.getEstimate(estimateId, versionNo);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "list_estimates",
    "List estimates with status, SITC ratio and totals.",
    {},
    async () => {
      const result = await services.listEstimates();
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "get_master_summary",
    "Counts of master records (materials, makes, design rules) currently active.",
    {},
    async () => {
      const result = await services.getMasterSummary();
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "search_past_estimates",
    "Search the indexed corpus of historical Greenberg proposals (RAG).",
    { query: z.string().min(1) },
    async ({ query }) => {
      const result = await services.searchPastEstimates(query);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.resource(
    "system-types",
    "pebble://module-02/system-types",
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(SYSTEM_TYPES),
        },
      ],
    }),
  );

  return server;
}
