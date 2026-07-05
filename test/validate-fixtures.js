import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures');

// Define Zod schemas that mirror the JSON schema contracts
const digitalStateValueSchema = z.object({
  Name: z.string(),
  Value: z.number().int(),
  IsSystem: z.boolean()
});

const timedValueSchema = z.object({
  Timestamp: z.string(),
  Value: z.union([
    z.number(),
    z.string(),
    z.null(),
    digitalStateValueSchema
  ]),
  UnitsAbbreviation: z.string().optional(),
  Good: z.boolean(),
  Questionable: z.boolean().optional(),
  Substituted: z.boolean().optional(),
  Annotated: z.boolean().optional()
});

const streamItemsSchema = z.object({
  Items: z.array(timedValueSchema),
  UnitsAbbreviation: z.string().optional(),
  Links: z.object({
    Next: z.string().optional()
  }).catchall(z.any()).optional()
}).catchall(z.any());

const streamsetItemsSchema = z.object({
  Items: z.array(
    z.object({
      WebId: z.string(),
      Name: z.string(),
      Path: z.string().optional(),
      UnitsAbbreviation: z.string().optional(),
      Items: z.array(timedValueSchema).optional(),
      Value: timedValueSchema.nullable().optional()
    }).catchall(z.any())
  )
}).catchall(z.any());

const summaryItemsSchema = z.object({
  Items: z.array(
    z.object({
      Type: z.string(),
      Value: timedValueSchema
    }).catchall(z.any())
  ),
  UnitsAbbreviation: z.string().optional()
}).catchall(z.any());

const pointMetadataSchema = z.object({
  WebId: z.string(),
  PointType: z.string(),
  DigitalSetName: z.string().nullable().optional(),
  Step: z.boolean(),
  Zero: z.number(),
  Span: z.number(),
  Future: z.boolean()
}).catchall(z.any());

const batchResponseSchema = z.record(
  z.object({
    Status: z.number().int(),
    Headers: z.record(z.any()).optional(),
    Content: z.any().optional()
  }).catchall(z.any())
);

const errorEnvelopeSchema = z.object({
  Errors: z.array(z.string()).optional()
}).catchall(z.any());

const searchResultsSchema = z.object({
  Items: z.array(
    z.object({
      WebId: z.string(),
      Name: z.string(),
      Path: z.string().optional()
    }).catchall(z.any())
  )
}).catchall(z.any());

const schemaMap = {
  'timed-value.schema.json': timedValueSchema,
  'digital-state-value.schema.json': digitalStateValueSchema,
  'stream-items.schema.json': streamItemsSchema,
  'streamset-items.schema.json': streamsetItemsSchema,
  'summary-items.schema.json': summaryItemsSchema,
  'point-metadata.schema.json': pointMetadataSchema,
  'batch-response.schema.json': batchResponseSchema,
  'error-envelope.schema.json': errorEnvelopeSchema,
  'search-results.schema.json': searchResultsSchema
};

function validateAll() {
  console.log('Validating fixtures against schemas...');
  const catalogPath = path.join(fixturesDir, 'catalog.json');
  if (!fs.existsSync(catalogPath)) {
    console.error('catalog.json not found!');
    process.exit(1);
  }

  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  let hasErrors = false;

  for (const [file, meta] of Object.entries(catalog)) {
    const filePath = path.join(fixturesDir, file);
    if (!fs.existsSync(filePath)) {
      console.error(`Fixture file missing: ${file}`);
      hasErrors = true;
      continue;
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const zodSchema = schemaMap[meta.schema];

    if (!zodSchema) {
      console.error(`Unknown schema: ${meta.schema} for file ${file}`);
      hasErrors = true;
      continue;
    }

    const result = zodSchema.safeParse(data);
    if (!result.success) {
      console.error(`Validation failed for ${file} using schema ${meta.schema}:`);
      console.error(JSON.stringify(result.error.format(), null, 2));
      hasErrors = true;
    } else {
      console.log(`${file} is valid`);
    }
  }

  if (hasErrors) {
    console.error('Fixture validation failed!');
    process.exit(1);
  } else {
    console.log('All fixtures validated successfully.');
  }
}

// Run if called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateAll();
}

export { validateAll };
