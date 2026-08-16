import { hostname } from 'node:os'
import { config } from './config.mjs'
import { ensurePlatformSchema, pool } from './db.mjs'
import { ensureIndices } from './elasticsearch.mjs'
import { deleteDocument, indexDocument } from './indexer.mjs'
import { claimJob, completeJob, failJob, recoverStaleJobs } from './jobs.mjs'

const workerId = `${hostname()}:${process.pid}`
let stopping = false

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

async function run() {
  await ensurePlatformSchema()
  await ensureIndices()
  await recoverStaleJobs()
  console.log(`[knowledge-worker] ready id=${workerId}`)
  while (!stopping) {
    const job = await claimJob(workerId)
    if (!job) { await delay(config.workerPollMs); continue }
    try {
      const result = job.operation === 'DELETE' ? await deleteDocument(job) : await indexDocument(job)
      await completeJob(job.job_id, result)
      console.log(`[knowledge-worker] completed job=${job.job_id} operation=${job.operation}`)
    } catch (error) {
      console.error(`[knowledge-worker] failed job=${job.job_id} attempt=${job.attempts}:`, error)
      await failJob(job, error)
    }
  }
  await pool.end()
}

for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => { stopping = true })
await run()
