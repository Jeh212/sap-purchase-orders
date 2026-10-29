import { z } from "zod"
import type { LlmTool } from "../llm/adapter.js"
import type { ToolCtx } from "./po.js"
import { build_payload, create, generate_evidence, read_package, validate } from "./po.js"

export interface RegisteredTool {
  name: string
  description: string
  schema: z.ZodType<Record<string, unknown>>
  llmTool: LlmTool
  execute(args: Record<string, unknown>, ctx: ToolCtx): Promise<string>
}

function jsonSchema(schema: z.ZodType<Record<string, unknown>>): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>
}

const readPackageSchema = z.object(read_package.args).strict()
const validateSchema = z.object(validate.args).strict()
const generateEvidenceSchema = z.object(generate_evidence.args).strict()
const buildPayloadSchema = z.object(build_payload.args).strict()
const createSchema = z.object(create.args).strict()

function makeRegistered(
  name: string,
  description: string,
  schema: z.ZodType<Record<string, unknown>>,
  execute: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<string>,
): RegisteredTool {
  return {
    name,
    description,
    schema,
    llmTool: { name, description, inputSchema: jsonSchema(schema) },
    execute,
  }
}

export const registeredTools: readonly RegisteredTool[] = [
  makeRegistered("po_read_package", read_package.description, readPackageSchema, async (args, ctx) =>
    read_package.execute(readPackageSchema.parse(args), ctx)),
  makeRegistered("po_validate", validate.description, validateSchema, async (args, ctx) =>
    validate.execute(validateSchema.parse(args), ctx)),
  makeRegistered("po_generate_evidence", generate_evidence.description, generateEvidenceSchema, async (args, ctx) =>
    generate_evidence.execute(generateEvidenceSchema.parse(args), ctx)),
  makeRegistered("po_build_payload", build_payload.description, buildPayloadSchema, async (args, ctx) =>
    build_payload.execute(buildPayloadSchema.parse(args), ctx)),
  makeRegistered("po_create", create.description, createSchema, async (args, ctx) =>
    create.execute(createSchema.parse(args), ctx)),
]

export const registeredToolsByName = new Map(
  registeredTools.map((tool) => [tool.name, tool]),
)

export const llmTools = registeredTools.map((tool) => tool.llmTool)
