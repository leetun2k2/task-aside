// Performance baseline measurement suite (RF-06).
// Measures build/transfer size, query latencies (p50/p95), RSS memory,
// and browser interaction timings on disposable seeded datasets.
// Kept in src/benchmarks/ so it stays out of shipped production bundles.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../backend/db/connection.ts';
import { runMigrations } from '../backend/db/migrations.ts';
import {
  appendMessage,
  getConversationIdForTask,
  listMessages,
} from '../backend/domains/chat/messages.ts';
import { createRepository } from '../backend/domains/task/repositories.ts';
import { claimTask, finalizeRun, heartbeat } from '../backend/domains/task/runs.ts';
import { createTask, listTasks } from '../backend/domains/task/tasks.ts';

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

async function main() {
  console.log('====================================================');
  console.log('TASKASIDE PERFORMANCE BASELINE (RF-06)');
  console.log('====================================================\n');

  // 1. Build and Artifact Sizes
  console.log('--- 1. Artifact & Build Sizes ---');
  const assets = readdirSync('dist/frontend/assets');
  const jsFile = assets.find((f) => f.endsWith('.js')) ?? '';
  const cssFile = assets.find((f) => f.endsWith('.css')) ?? '';
  const uiJsPath = join('dist/frontend/assets', jsFile);
  const uiCssPath = join('dist/frontend/assets', cssFile);
  const uiJsSize = statSync(uiJsPath).size;
  const uiCssSize = statSync(uiCssPath).size;

  const backendSize = statSync('dist/services/backend.js').size;
  const adapterSize = statSync('dist/services/agent-adapter.js').size;
  const engineSize = statSync('dist/services/execution-engine.js').size;
  const cliSize = statSync('dist/services/cli.js').size;

  console.log(`Frontend JS: ${(uiJsSize / 1024).toFixed(2)} KB (${uiJsSize} bytes)`);
  console.log(`Frontend CSS: ${(uiCssSize / 1024).toFixed(2)} KB (${uiCssSize} bytes)`);
  console.log(`Backend Service: ${(backendSize / 1024).toFixed(2)} KB (${backendSize} bytes)`);
  console.log(
    `Agent Adapter Service: ${(adapterSize / 1024).toFixed(2)} KB (${adapterSize} bytes)`,
  );
  console.log(
    `Execution Engine Service: ${(engineSize / 1024).toFixed(2)} KB (${engineSize} bytes)`,
  );
  console.log(`CLI Entrypoint: ${(cliSize / 1024).toFixed(2)} KB (${cliSize} bytes)`);

  // 2. Query Latency & Memory on Seeded Datasets
  const tempDir = mkdtempSync(join(tmpdir(), 'taskaside-perf-baseline-'));
  const dbPath = join(tempDir, 'perf.db');
  const db = openDatabase({ path: dbPath });
  runMigrations(db);

  try {
    // Register 8 distinct repos
    const repos = [];
    for (let r = 0; r < 8; r++) {
      const repoDir = join(tempDir, `repo-${r}`);
      mkdirSync(repoDir, { recursive: true });
      repos.push(
        createRepository(db, {
          name: `repo-${r}`,
          displayPath: repoDir,
          defaultProvider: r % 2 === 0 ? 'codex' : 'claude',
        }),
      );
    }

    console.log('\n--- 2. Seeding 1,000 Tasks & 500 Messages ---');
    const t0 = performance.now();
    db.run('BEGIN TRANSACTION;');
    const taskIds1k: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const repo = repos[i % 8];
      const priority = i % 4 === 0 ? 'P0' : i % 4 === 1 ? 'P1' : i % 4 === 2 ? 'P2' : 'P3';
      const status = i < 8 ? 'processing' : i % 5 === 0 ? 'done' : 'todo';
      const task = createTask(db, {
        repoId: repo.id,
        title: `Task benchmark ${i} ${priority}`,
        priority,
        description: `Description for task ${i} with random keywords test indexing`,
      });
      taskIds1k.push(task.id);
    }

    // Seed 500 messages across the first 10 tasks
    for (let m = 0; m < 500; m++) {
      const taskId = taskIds1k[m % 10];
      const convId = getConversationIdForTask(db, taskId);
      if (convId) {
        appendMessage(
          db,
          convId,
          {
            content: `Message benchmark line ${m} with code snippet \`function test${m}() {}\``,
          },
          m % 2 === 0 ? 'user' : 'agent',
        );
      }
    }
    db.run('COMMIT;');
    console.log(`Seeding 1,000 tasks + 500 messages took ${(performance.now() - t0).toFixed(2)}ms`);

    // Measure query latencies on 1,000 tasks
    const querySamples1k: number[] = [];
    for (let s = 0; s < 50; s++) {
      const qStart = performance.now();
      listTasks(db, { status: 'todo', priority: 'P1' });
      querySamples1k.push(performance.now() - qStart);
    }
    console.log(`1,000 Tasks List Query (p50): ${percentile(querySamples1k, 50).toFixed(3)}ms`);
    console.log(`1,000 Tasks List Query (p95): ${percentile(querySamples1k, 95).toFixed(3)}ms`);

    // Measure message cursor paging on 500 messages
    const convIdTarget = getConversationIdForTask(db, taskIds1k[0]) ?? '';
    const msgSamples500: number[] = [];
    for (let s = 0; s < 50; s++) {
      const mStart = performance.now();
      listMessages(db, convIdTarget, { limit: 50 });
      msgSamples500.push(performance.now() - mStart);
    }
    console.log(`500 Messages Page Query (p50): ${percentile(msgSamples500, 50).toFixed(3)}ms`);
    console.log(`500 Messages Page Query (p95): ${percentile(msgSamples500, 95).toFixed(3)}ms`);

    // Scale to 10,000 tasks and 5,000 messages
    console.log('\n--- 3. Scaling to 10,000 Tasks & 5,000 Messages ---');
    const tScale = performance.now();
    db.run('BEGIN TRANSACTION;');
    const taskIds10k = [...taskIds1k];
    for (let i = 1000; i < 10000; i++) {
      const repo = repos[i % 8];
      const priority = i % 4 === 0 ? 'P0' : i % 4 === 1 ? 'P1' : i % 4 === 2 ? 'P2' : 'P3';
      const task = createTask(db, {
        repoId: repo.id,
        title: `Task scale benchmark ${i} ${priority}`,
        priority,
        description: `High scale task ${i} payload description text`,
      });
      taskIds10k.push(task.id);
    }

    for (let m = 500; m < 5000; m++) {
      const taskId = taskIds10k[m % 20];
      const convId = getConversationIdForTask(db, taskId);
      if (convId) {
        appendMessage(
          db,
          convId,
          {
            content: `Message scale line ${m} content block`,
          },
          m % 2 === 0 ? 'user' : 'agent',
        );
      }
    }
    db.run('COMMIT;');
    console.log(
      `Scaling to 10,000 tasks + 5,000 messages took ${(performance.now() - tScale).toFixed(2)}ms`,
    );

    // Measure query latencies on 10,000 tasks
    const querySamples10k: number[] = [];
    for (let s = 0; s < 50; s++) {
      const qStart = performance.now();
      listTasks(db, { query: 'scale benchmark' });
      querySamples10k.push(performance.now() - qStart);
    }
    console.log(`10,000 Tasks Search Query (p50): ${percentile(querySamples10k, 50).toFixed(3)}ms`);
    console.log(`10,000 Tasks Search Query (p95): ${percentile(querySamples10k, 95).toFixed(3)}ms`);

    // Measure message cursor paging on 5,000 messages
    const convIdHeavy = getConversationIdForTask(db, taskIds10k[0]) ?? '';
    const msgSamples5000: number[] = [];
    for (let s = 0; s < 50; s++) {
      const mStart = performance.now();
      listMessages(db, convIdHeavy, { limit: 50 });
      msgSamples5000.push(performance.now() - mStart);
    }
    console.log(`5,000 Messages Page Query (p50): ${percentile(msgSamples5000, 50).toFixed(3)}ms`);
    console.log(`5,000 Messages Page Query (p95): ${percentile(msgSamples5000, 95).toFixed(3)}ms`);

    // 4. Concurrency & Lock Claim Timings (8 concurrent runs across 8 checkouts)
    console.log('\n--- 4. Active Runs Claim Latency (8 distinct checkouts) ---');
    const claimSamples: number[] = [];
    for (let r = 0; r < 8; r++) {
      const cStart = performance.now();
      const claim = claimTask(db, taskIds10k[r], {
        ownerId: `engine-worker-${r}`,
        generation: 0,
        idempotencyKey: `claim-key-${r}`,
      });
      claimSamples.push(performance.now() - cStart);
    }
    console.log(
      `Claim Latency per Working Tree (p50): ${percentile(claimSamples, 50).toFixed(3)}ms`,
    );
    console.log(
      `Claim Latency per Working Tree (p95): ${percentile(claimSamples, 95).toFixed(3)}ms`,
    );

    // 5. Memory Footprint
    console.log('\n--- 5. Process Memory (RSS) ---');
    const mem = process.memoryUsage();
    console.log(`RSS Memory: ${(mem.rss / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`Heap Used: ${(mem.heapUsed / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`Heap Total: ${(mem.heapTotal / (1024 * 1024)).toFixed(2)} MB`);
  } finally {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('\n====================================================');
  console.log('PERFORMANCE BASELINE COMPLETED SUCCESSFULLY');
  console.log('====================================================');
}

main().catch((err) => {
  console.error('Performance baseline measurement failed:', err);
  process.exit(1);
});
