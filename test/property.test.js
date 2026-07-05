import test from 'node:test';
import assert from 'node:assert';
import fc from 'fast-check';
import { TagPath } from '../src/domain/values/TagPath.js';
import { Paging } from '../src/domain/values/Paging.js';
import { TimeRange } from '../src/domain/values/TimeRange.js';
import { PiWebApiClient } from '../src/gateway/pi-web-api-client.js';

// Minimal mock of client dependencies to test _splitBatch
const mockConfig = { PIWEBAPI_BASE_URL: 'https://pi.server/piwebapi' };
const mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => mockLogger };
const mockAuth = { decorate: async () => {} };
const mockTrust = { getTlsOptions: () => ({}) };

test('TagPath - property-based path parsing', () => {
  // Helper to check valid characters for path parts
  const partGen = fc.stringOf(
    fc.char().filter(c => /[a-zA-Z0-9_-]/.test(c)),
    { minLength: 1, maxLength: 20 }
  );

  // Property 1: Valid path construction
  fc.assert(
    fc.property(
      partGen, // server name
      fc.array(partGen, { minLength: 1, maxLength: 5 }), // components
      fc.boolean(), // with attribute pipe
      (server, parts, hasPipe) => {
        let resourcePath = parts.join('\\');
        if (hasPipe) {
          resourcePath += '|attribute';
        }
        const fullPath = `\\\\${server}\\${resourcePath}`;

        const tagPath = new TagPath(fullPath);
        
        assert.strictEqual(tagPath.server, server);
        assert.strictEqual(tagPath.path, fullPath);
        
        const isAfExpected = hasPipe || parts.length > 1;
        assert.strictEqual(tagPath.isAf, isAfExpected);
      }
    )
  );

  // Property 2: Invalid paths must throw
  fc.assert(
    fc.property(
      fc.string(),
      (str) => {
        // If it doesn't start with \\, or has less than 2 parts, it should throw
        const parts = str.replace(/\//g, '\\').slice(2).split('\\').filter(Boolean);
        const shouldThrow = !str.startsWith('\\\\') || parts.length < 2;

        if (shouldThrow) {
          assert.throws(() => new TagPath(str));
        } else {
          // If valid, should not throw
          const tag = new TagPath(str);
          assert.ok(tag.path);
        }
      }
    )
  );
});

test('Paging - property-based token serialization and paging math', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 100000 }), // startIndex
      fc.integer({ min: 1, max: 1000 }),   // pageSize
      fc.string({ minLength: 5, maxLength: 16 }), // queryHash
      (startIndex, pageSize, queryHash) => {
        const paging = new Paging({ startIndex, pageSize, queryHash });
        
        assert.strictEqual(paging.startIndex, startIndex);
        assert.strictEqual(paging.pageSize, pageSize);
        assert.strictEqual(paging.queryHash, queryHash);

        // Roundtrip token parsing
        const token = paging.toToken();
        const parsed = Paging.parseToken(token, queryHash);

        assert.strictEqual(parsed.startIndex, startIndex);
        assert.strictEqual(parsed.pageSize, pageSize);
        assert.strictEqual(parsed.queryHash, queryHash);

        // Mismatch queryHash should throw
        assert.throws(() => Paging.parseToken(token, queryHash + '_mismatch'));

        // Math invariant: next() page increments correctly
        const itemsReturned = Math.floor(Math.random() * 500);
        const nextPaging = paging.next(itemsReturned);
        assert.strictEqual(nextPaging.startIndex, startIndex + itemsReturned);
        assert.strictEqual(nextPaging.pageSize, pageSize);
        assert.strictEqual(nextPaging.queryHash, queryHash);
      }
    )
  );
});

test('TimeRange - relative and absolute time parsing properties', () => {
  const relativeUnits = ['s', 'm', 'h', 'd', 'w', 'mo', 'y'];
  const baseRefs = ['*', 't', 'y', 'now', 'sunday', 'mon', 'fri'];

  fc.assert(
    fc.property(
      fc.constantFrom(...baseRefs),
      fc.constantFrom(...relativeUnits),
      fc.integer({ min: 1, max: 365 }),
      fc.boolean(), // sign prefix
      (base, unit, offset, isMinus) => {
        const sign = isMinus ? '-' : '+';
        const relativeTime = `${base}${sign}${offset}${unit}`;
        
        // Should parse relative time cleanly without throwing
        const range = new TimeRange(relativeTime, '*');
        assert.strictEqual(range.startTime, relativeTime);
        assert.strictEqual(range.endTime, '*');
      }
    )
  );
});

test('PiWebApiClient - _splitBatch partitioning properties', () => {
  const client = new PiWebApiClient(mockConfig, mockLogger, mockAuth, mockTrust);

  fc.assert(
    fc.property(
      // Generate flat list of batch requests (no dependencies)
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 5 }),
        fc.record({
          Method: fc.constant('GET'),
          Resource: fc.string({ minLength: 10, maxLength: 100 })
        })
      ),
      fc.integer({ min: 50, max: 1000 }), // artificial size limit
      (batchPlan, limit) => {
        const keys = Object.keys(batchPlan);
        if (keys.length === 0) return;

        const partitions = client._splitBatch(batchPlan, limit);

        // Invariant 1: Every key in the original batch is present in exactly one partition
        const resolvedKeys = new Set();
        for (const p of partitions) {
          Object.keys(p).forEach(k => {
            assert.ok(!resolvedKeys.has(k), `Duplicate key ${k} across partitions`);
            resolvedKeys.add(k);
          });
        }
        assert.strictEqual(resolvedKeys.size, keys.length);
        keys.forEach(k => assert.ok(resolvedKeys.has(k)));

        // Invariant 2: No partition size exceeds limit (unless single key exceeds limit)
        for (const p of partitions) {
          const size = JSON.stringify(p).length;
          if (Object.keys(p).length > 1) {
            assert.ok(size <= limit, `Partition size ${size} exceeded limit ${limit}`);
          }
        }
      }
    )
  );

  // Property 3: Dependent batch splitting
  fc.assert(
    fc.property(
      fc.integer({ min: 50, max: 2000 }), // limit
      (limit) => {
        // Construct a batch plan where child depends on parent
        const batchPlan = {
          parent1: { Method: 'GET', Resource: '/streams/1' },
          parent2: { Method: 'GET', Resource: '/streams/2' },
          child1: { Method: 'GET', Resource: '/streams/3', ParentIds: ['parent1'] },
          child2: { Method: 'GET', Resource: '/streams/4', ParentIds: ['parent2'] },
          child3: { Method: 'GET', Resource: '/streams/5', ParentIds: ['parent1', 'parent2'] }
        };

        const partitions = client._splitBatch(batchPlan, limit);

        // Invariant: For any child in a partition, all its parents are also present in that SAME partition
        for (const p of partitions) {
          for (const [key, subReq] of Object.entries(p)) {
            if (subReq.ParentIds) {
              for (const parentId of subReq.ParentIds) {
                assert.ok(
                  p[parentId] !== undefined,
                  `Child ${key} separated from parent ${parentId} in partition`
                );
              }
            }
          }
        }
      }
    )
  );
});
